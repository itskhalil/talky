/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        text: "var(--color-text)",
        "text-secondary": "var(--color-text-secondary)",
        background: "var(--color-background)",
        "background-sidebar": "var(--color-background-sidebar)",
        accent: "var(--color-accent)",
        "accent-soft": "var(--color-accent-soft)",
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        "logo-primary": "var(--color-logo-primary)",
        "logo-stroke": "var(--color-logo-stroke)",
        "text-stroke": "var(--color-text-stroke)",
        "mid-gray": "var(--color-mid-gray)",
      },
    },
  },
  plugins: [],
};
