// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CorrectionForm } from "./CorrectionForm";

describe("correction form", () => {
  it("resets the correction only after an applied receipt", async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<CorrectionForm onSubmit={onSubmit} />);
    const input = screen.getByLabelText("补充或修正任务要求") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Do not open the payment page" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(input.value).toBe("Do not open the payment page");
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(input.value).toBe("");
  });
});
