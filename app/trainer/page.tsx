import type { Metadata, Viewport } from 'next';
import { TrainerClient } from './TrainerClient';
import './trainer.css';

export const metadata: Metadata = {
  title: 'Approach Trainer — ApproachViz',
  description:
    'Offline, mobile-first instrument approach trainer. Fly FAA CIFP approaches, track course and glidepath, and get scored on your instrument technique.',
  manifest: '/trainer.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Approach Trainer'
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0a0a14'
};

export const dynamic = 'force-static';

export default function TrainerPage() {
  return (
    <main className="tr-root">
      <TrainerClient />
    </main>
  );
}
