import type { Metadata } from "next";
import "./globals.css";
import { NavBar } from "../components/NavBar";

export const metadata: Metadata = {
  title: "DeviceYard",
  description: "DeviceYard — run Maestro tests on your Android hardware, inspect failures, and manage your device yard.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('deviceyard-appearance');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:'system'}catch{}" }} /></head>
      <body className="min-h-full flex flex-col">
        <NavBar />
        {children}
      </body>
    </html>
  );
}
