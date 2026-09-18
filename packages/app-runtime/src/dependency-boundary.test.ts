import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "./index.js";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("app-runtime dependency boundaries", () => {
  it("keeps production imports/exports inside the declared package graph", async () => {
    const appRuntimeFiles = await productionFiles(join(repositoryRoot, "packages", "app-runtime", "src"));
    const cliFiles = await productionFiles(join(repositoryRoot, "apps", "cli", "src"));
    const runtimeFiles = await productionFiles(join(repositoryRoot, "packages", "runtime", "src"));
    const appRuntimeRoot = join(repositoryRoot, "packages", "app-runtime", "src");
    const cliRoot = join(repositoryRoot, "apps", "cli", "src");
    const runtimeRoot = join(repositoryRoot, "packages", "runtime", "src");
    const violations: string[] = [];
    const rules: Array<{ label: string; files: string[]; root: string; allowed: ReadonlySet<string> }> = [
      {
        label: "app-runtime",
        files: appRuntimeFiles,
        root: appRuntimeRoot,
        allowed: new Set([
          "@computer-harness/computer-cua",
          "@computer-harness/computer-osworld",
          "@computer-harness/context",
          "@computer-harness/memory",
          "@computer-harness/planning",
          "@computer-harness/protocol",
          "@computer-harness/provider-glm",
          "@computer-harness/provider-qwen",
          "@computer-harness/risk-guard",
          "@computer-harness/runtime",
          "@computer-harness/trajectory",
        ]),
      },
      {
        label: "cli",
        files: cliFiles,
        root: cliRoot,
        allowed: new Set(["@computer-harness/app-runtime", "@computer-harness/protocol", "@computer-harness/runtime", "@computer-harness/trajectory", "string-width"]),
      },
      {
        label: "runtime",
        files: runtimeFiles,
        root: runtimeRoot,
        allowed: new Set(["@computer-harness/protocol", "@computer-harness/trajectory"]),
      },
    ];
    for (const rule of rules) {
      for (const file of rule.files) {
        const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        source.forEachChild((node) => {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
              const moduleSpecifier = node.moduleSpecifier;
            if (moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)) {
              const specifier = moduleSpecifier.text;
              if (specifier.startsWith(".") && relativeImportEscapesRoot(specifier, file, rule.root)) {
                violations.push(`${rule.label}:${relative(repositoryRoot, file)} relative import escapes its src root: ${specifier}`);
              } else if (!specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("vitest") && !rule.allowed.has(specifier)) {
                violations.push(`${rule.label}:${relative(repositoryRoot, file)} imports ${specifier}`);
              }
            }
          }
          node.forEachChild((child) => inspectDynamicImport(child, rule, file, violations));
        });
      }
    }
    expect(violations).toEqual([]);
  });

  it("consumes the public root exports without loading a private source path", () => {
    expect(publicApi.createRun).toBeTypeOf("function");
    expect(publicApi.createProvider).toBeTypeOf("function");
    expect(publicApi.createComputer).toBeTypeOf("function");
    expect(publicApi.writeRunReport).toBeTypeOf("function");
  });

  it("rejects a synthetic relative import that escapes the owning package src root", () => {
    const appRuntimeRoot = join(repositoryRoot, "packages", "app-runtime", "src");
    const sourceFile = join(appRuntimeRoot, "config.ts");
    expect(relativeImportEscapesRoot("./index.js", sourceFile, appRuntimeRoot)).toBe(false);
    expect(relativeImportEscapesRoot("../../../apps/cli/src/index.js", sourceFile, appRuntimeRoot)).toBe(true);
  });
});

async function productionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await productionFiles(path));
    else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function inspectDynamicImport(node: ts.Node, rule: { label: string; root: string; allowed: ReadonlySet<string> }, file: string, violations: string[]): void {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments[0];
    if (argument === undefined || !ts.isStringLiteralLike(argument)) {
      violations.push(`${rule.label}:${relative(repositoryRoot, file)} has a non-literal dynamic import`);
    } else if (argument.text.startsWith(".") && relativeImportEscapesRoot(argument.text, file, rule.root)) {
      violations.push(`${rule.label}:${relative(repositoryRoot, file)} relative dynamic import escapes its src root: ${argument.text}`);
    } else if (argument.text.startsWith("@computer-harness/") && !rule.allowed.has(argument.text)) {
      violations.push(`${rule.label}:${relative(repositoryRoot, file)} dynamically imports ${argument.text}`);
    }
  }
  node.forEachChild((child) => inspectDynamicImport(child, rule, file, violations));
}

function relativeImportEscapesRoot(specifier: string, sourceFile: string, root: string): boolean {
  const target = resolve(dirname(sourceFile), specifier);
  const pathFromRoot = relative(root, target);
  return pathFromRoot.length > 0 && (pathFromRoot === ".." || pathFromRoot.startsWith(`..${"\\"}`) || pathFromRoot.startsWith(`..${"/"}`) || isAbsolute(pathFromRoot));
}
