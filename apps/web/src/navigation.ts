/** Navigates within the phone app without unloading the document. */
export function navigateWithinApp(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
