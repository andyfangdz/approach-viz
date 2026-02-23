import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import '@/app/App.css';
import DatadogRumInit from '@/app/DatadogRumInit';

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
  viewportFit: 'cover',
  themeColor: '#14305a'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <DatadogRumInit />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
