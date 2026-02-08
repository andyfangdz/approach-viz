import type { Metadata, Viewport } from 'next';
import '@/src/App.css';

export const metadata: Metadata = {
  title: 'ApproachViz',
  description: '3D visualization for instrument approach procedures'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
