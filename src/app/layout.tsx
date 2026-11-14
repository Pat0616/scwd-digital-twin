import type { Metadata, Viewport } from "next";
import { Inter, Montserrat } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-inter" });
// the TapWater wordmark's geometric sans: the brand name, headings and big numbers
const display = Montserrat({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-display-family" });

export const metadata: Metadata = {
  title: "TapWater · Sorsogon Water Monitor",
  description: "Live water network monitor for the Sorsogon City Water District, from its digital twin",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#01112e" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
