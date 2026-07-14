import "./globals.css";
import { Fraunces, Hanken_Grotesk, JetBrains_Mono, Lato, Playfair_Display } from "next/font/google";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-serif",
  display: "swap",
});
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});
const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-lux-serif",
  display: "swap",
});
const lato = Lato({
  subsets: ["latin"],
  weight: ["300", "400", "700"],
  variable: "--font-lux-sans",
  display: "swap",
});

export const metadata = {
  title: "Hermes OS",
  description: "Personal assistant operating system",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${hanken.variable} ${jetbrains.variable} ${playfair.variable} ${lato.variable}`}
    >
      <body style={{ fontFamily: "var(--font-sans, system-ui, sans-serif)" }}>
        {children}
      </body>
    </html>
  );
}
