import type { Metadata } from 'next';
import '@/src/App.css';

export const metadata: Metadata = {
  title: 'ApproachViz',
  description: '3D visualization for instrument approach procedures'
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
