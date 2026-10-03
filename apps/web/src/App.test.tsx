// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./api", async (importOriginal) => {
  const api = await importOriginal<typeof import("./api")>();
  return {
    ...api,
    getPhoneSession: vi.fn(async () => ({ csrfToken: "csrf-test", expiresAt: new Date(Date.now() + 60_000).toISOString() })),
    getVoiceInputCapabilities: vi.fn(async () => ({ available: false })),
  };
});

vi.mock("./HomeScreen", () => ({
  HomeScreen: ({ commonSiteChoices = [] }: { commonSiteChoices?: readonly { label: string; url: string }[] }) => (
    <div>{commonSiteChoices.map((choice) => <span key={choice.url}>{choice.label}</span>)}</div>
  ),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("App composition", () => {
  it("forwards injected common-site choices to HomeScreen", async () => {
    render(<App commonSiteChoices={[{ label: "Example portal", url: "https://portal.example/" }]} />);

    expect(await screen.findByText("Example portal")).toBeDefined();
  });
});
