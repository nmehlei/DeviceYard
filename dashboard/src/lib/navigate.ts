// A one-line indirection around window.location.assign, which cannot be
// mocked directly in this project's jsdom (see this task's brief for why).
// Every redirect in this app goes through this function so tests mock this
// module instead of the browser global.
export function navigate(url: string): void {
  window.location.assign(url);
}
