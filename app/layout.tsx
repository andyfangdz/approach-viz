import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import '@/src/App.css';

export const metadata: Metadata = {
  title: 'ApproachViz',
  description: '3D visualization for instrument approach procedures',
  manifest: '/manifest.webmanifest'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#14305a'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
