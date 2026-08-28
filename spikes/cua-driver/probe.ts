import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ClickInput,
  CuaDriver,
  EndSessionInput,
  GetDesktopStateInput,
  GetScreenSizeInput,
  StartSessionInput,
  TypeTextInput,
} from "@trycua/cua-driver";

interface ProbeOptions {
  allowInput: boolean;
  click?: { x: number; y: number };
  typeText?: string;
  outputDir: string;
  session: string;
}

function parseOptions(args: string[]): ProbeOptions {
  const allowInput = args.includes("--allow-input");
  const session = readStringOption(args, "--session") ?? `probe-${Date.now()}`;
  const outputDir = resolve(
    readStringOption(args, "--output") ?? join("runs", session),
  );
  const clickX = readNumberOption(args, "--click-x");
  const clickY = readNumberOption(args, "--click-y");
  const click = clickX === undefined || clickY === undefined ? undefined : { x: clickX, y: clickY };
  const typeText = readStringOption(args, "--type");

  if (!allowInput && (click || typeText !== undefined)) {
    throw new Error("input options require --allow-input");
  }
  if (clickX !== undefined && clickY === undefined || clickX === undefined && clickY !== undefined) {
    throw new Error("--click-x and --click-y must be provided together");
  }

  return { allowInput, click, typeText, outputDir, session };
}

function readStringOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberOption(args: string[], name: string): number | undefined {
  const raw = readStringOption(args, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function serializableToolResult(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const candidate = value as Record<string, unknown>;
  const images = Array.isArray(candidate.images)
    ? candidate.images.map((image) => {
        if (!image || typeof image !== "object") {
          return image;
        }
        const imageRecord = image as Record<string, unknown>;
        return {
          mimeType: imageRecord.mimeType,
          dataBase64Bytes:
            typeof imageRecord.dataBase64 === "string" ? imageRecord.dataBase64.length : 0,
        };
      })
    : undefined;
  return {
    text: candidate.text,
    isError: candidate.isError,
    errorCode: candidate.errorCode,
    degraded: candidate.degraded,
    structuredJson: candidate.structuredJson,
    rawJson: candidate.rawJson,
    images,
    action: candidate.action,
    verification: candidate.verification,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.outputDir, { recursive: true });
  const screenshotPaths: string[] = [];
  const startedAt = new Date().toISOString();
  const driver = CuaDriver.create(undefined);
  let closed = false;

  const capture = async (label: string) => {
    const screenshotPath = join(options.outputDir, `${label}.png`);
    const result = await driver.getDesktopState(
      GetDesktopStateInput.new({ session: options.session, screenshotOutFile: screenshotPath }),
    );
    screenshotPaths.push(screenshotPath);
    await writeFile(
      join(options.outputDir, `${label}.json`),
      JSON.stringify(serializableToolResult(result), null, 2),
      "utf8",
    );
    return result;
  };

  try {
    const metadata = await driver.metadata();
    await writeFile(
      join(options.outputDir, "metadata.json"),
      JSON.stringify(
        {
          probeVersion: "0.1.0",
          startedAt,
          host: { platform: process.platform, arch: process.arch, node: process.version },
          driver: metadata,
          options: { ...options, outputDir: undefined },
        },
        null,
        2,
      ),
      "utf8",
    );

    await driver.startSession(StartSessionInput.new({ session: options.session }));
    const screenSize = await driver.getScreenSize(GetScreenSizeInput.new({ session: options.session }));
    await writeFile(
      join(options.outputDir, "screen-size.json"),
      JSON.stringify(serializableToolResult(screenSize), null, 2),
      "utf8",
    );
    await capture("before");

    if (options.click) {
      const result = await driver.click(
        ClickInput.new({ x: options.click.x, y: options.click.y, session: options.session }),
      );
      await writeFile(
        join(options.outputDir, "click.json"),
        JSON.stringify(serializableToolResult(result), null, 2),
        "utf8",
      );
      await capture("after-click");
    }

    if (options.typeText !== undefined) {
      const result = await driver.typeText(
        TypeTextInput.new({ text: options.typeText, session: options.session }),
      );
      await writeFile(
        join(options.outputDir, "type.json"),
        JSON.stringify(serializableToolResult(result), null, 2),
        "utf8",
      );
      await capture("after-type");
    }

    await driver.endSession(EndSessionInput.new({ session: options.session }));
    closed = true;
    console.log(
      JSON.stringify(
        {
          ok: true,
          outputDir: options.outputDir,
          session: options.session,
          screenshotPaths,
          inputExecuted: Boolean(options.click || options.typeText !== undefined),
        },
        null,
        2,
      ),
    );
  } finally {
    if (!closed) {
      try {
        await driver.endSession(EndSessionInput.new({ session: options.session }));
      } catch {
        // Preserve the original probe error; shutdown below still runs.
      }
    }
    await driver.shutdown();
    const destroy = (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy;
    destroy?.call(driver);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
