import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Unified Intelligent Infrastructure — Digital Twin',
  description: 'Connect Everything. Understand Anything. Automate Intelligence.',
};

export const viewport: Viewport = { themeColor: '#0b1220', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
