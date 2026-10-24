import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

const app = mount(App, { target: document.body });

// BioBuzz: no service worker. This copy is served by the robot's dashboard, and a
// cache-first worker there would also cache the dashboard's own pages and keep serving
// stale ones after an update. Remove any worker an earlier build installed.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) registration.unregister();
  }).catch(() => {});
}

export default app;
