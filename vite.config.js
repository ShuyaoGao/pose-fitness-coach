import { defineConfig } from "vite";

// Vite 配置（开发版）。
// - 开发版入口是根目录的 dev.html（不是 index.html：index.html 留给 GitHub Pages / 解压后双击的跳转页，
//   它只负责跳到 play/index.html）。npm run dev 会自动打开 http://localhost:5173/dev.html。
// - server.host: 设为 true 可让同一局域网的手机/平板也能访问（演示时方便）。
//   注意：摄像头（getUserMedia）只在「安全上下文」可用，即 localhost 或 https。
//   局域网 IP 访问默认是 http，浏览器会拒绝开摄像头；如需手机演示请配 https。
export default defineConfig({
  server: {
    open: "/dev.html",
    host: true,
  },
  build: {
    rollupOptions: { input: "dev.html" },
  },
});
