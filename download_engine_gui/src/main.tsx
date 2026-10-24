import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Island from "./Island";
import { installNativeFeel } from "./lib/nativeFeel";

// One bundle, two windows: the island loads this same page with `#island`.
const isIsland = window.location.hash === "#island";

installNativeFeel();

// Before the first paint, not in an effect: until these classes land the page
// carries the app's own background, which shows as a pale band behind the notch.
if (isIsland) document.documentElement.classList.add("island", "dark");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isIsland ? <Island /> : <App />}</React.StrictMode>,
);
