import type { Config } from "tailwindcss";

// VEGALAB terminal palette. Green/red are STRICTLY for direction/PnL sign;
// amber marks active/ATM/self; cyan is IV; violet is the hedge bucket.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0a0e14",
        panel: "#0f1419",
        edge: "#1c2530",
        ink: "#c0caf5",
        dim: "#5c6a82",
        amber: "#ffb454",
        up: "#7fd962",
        down: "#ff6b7a",
        iv: "#5ac8d8",
        hedge: "#b48ead",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
