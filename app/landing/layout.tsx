import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ApproachViz — 3D Instrument Approach Visualization',
  description:
    'Visualize instrument approaches, live MRMS weather, ADS-B traffic, terrain, and airspace in three dimensions.'
};

export default function LandingLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return children;
}
