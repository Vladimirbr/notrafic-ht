import { defineConfig } from "vite";

const proxy = {
  "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000",
};
const headers = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
};

export default defineConfig({
  server: { host: "localhost", port: 5173, strictPort: true, proxy, headers },
  preview: { host: "localhost", port: 5173, strictPort: true, proxy, headers },
});
