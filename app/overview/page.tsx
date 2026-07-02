import type { Metadata } from 'next';
import { Barlow_Condensed, IBM_Plex_Mono, Space_Grotesk } from 'next/font/google';
import OverviewClient from '@/app/overview/OverviewClient';
import '@/app/overview/overview.css';

const display = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--ov-font-display'
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--ov-font-mono'
});

const body = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--ov-font-body'
});

export const metadata: Metadata = {
  title: 'ApproachViz — System Overview',
  description:
    'Interactive architecture briefing: data pipeline, Rust runtime, shared core, and the web/native rendering stack behind ApproachViz.'
};

export default function OverviewPage() {
  return (
    <div className={`${display.variable} ${mono.variable} ${body.variable}`}>
      <OverviewClient />
    </div>
  );
}
