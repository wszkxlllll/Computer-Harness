// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorrectionForm } from "./CorrectionForm";

afterEach(() => cleanup());

describe("correction form", () => {
  it("exposes a named form and keyboard-focusable controls with the correction hint attached", () => {
    render(<CorrectionForm onSubmit={vi.fn()} />);
    const form = screen.getByRole("form", { name: "补充或修正表单" });
    const input = screen.getByRole("textbox", { name: "补充或修正任务要求" }) as HTMLTextAreaElement;
    const submit = screen.getByRole("button", { name: "发送补充要求" }) as HTMLButtonElement;

    expect(form.contains(input)).toBe(true);
    expect(form.contains(submit)).toBe(true);
    expect(input.getAttribute("aria-describedby")).toBe("correction-help");
    expect(input.tabIndex).toBe(0);
    expect(submit.tabIndex).toBe(0);
  });

  it("resets the correction only after an applied receipt", async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<CorrectionForm onSubmit={onSubmit} />);
    const input = screen.getByLabelText("补充或修正任务要求") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Do not open the payment page" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenNthCalledWith(1, "Do not open the payment page");
    expect(input.value).toBe("Do not open the payment page");
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenNthCalledWith(2, "Do not open the payment page");
    expect(input.value).toBe("");
  });
});
