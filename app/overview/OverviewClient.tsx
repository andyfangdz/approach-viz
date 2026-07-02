'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SECTIONS, type Block, type SubSection } from '@/app/overview/overview-content';
import {
  DbzLegend,
  MrmsPipelineDiagram,
  PlateProjectionDiagram,
  SystemMap,
  WorkerTopologyDiagram
} from '@/app/overview/diagrams';
import { githubUrlForPath } from '@/app/overview/github';
import { CodeHighlight } from '@/app/overview/syntax';

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      const token = part.slice(1, -1);
      const href = githubUrlForPath(token);
      if (href) {
        return (
          <a key={i} className="ov-code-link" href={href} target="_blank" rel="noreferrer">
            <code>{token}</code>
          </a>
        );
      }
      return <code key={i}>{token}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

/* Code-block titles often lead with a repo path — link that portion. */
function CodeBlockTitle({ title }: { title: string }) {
  const match = title.match(/^(\S+)([\s\S]*)$/);
  const href = match ? githubUrlForPath(match[1]) : null;
  if (!match || !href) {
    return <span>{title}</span>;
  }
  return (
    <span>
      <a href={href} target="_blank" rel="noreferrer">
        {match[1]}
      </a>
      {match[2]}
    </span>
  );
}

function DetailBlock({ summary, body }: { summary: string; body: Block[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ov-detail ${open ? 'ov-open' : ''}`}>
      <button
        type="button"
        className="ov-detail-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="ov-caret">▶</span>
        {summary}
      </button>
      {open && (
        <div className="ov-detail-body">
          {body.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'p':
      return <p className="ov-p">{renderInline(block.text)}</p>;
    case 'list':
      return (
        <ul className="ov-list">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case 'files':
      return (
        <div className="ov-files">
          {block.paths.map((p) => {
            const href = githubUrlForPath(p);
            if (href) {
              return (
                <a className="ov-file-chip" href={href} target="_blank" rel="noreferrer" key={p}>
                  {p}
                </a>
              );
            }
            return (
              <span className="ov-file-chip" key={p}>
                {p}
              </span>
            );
          })}
        </div>
      );
    case 'table':
      return (
        <div className="ov-table-wrap">
          <table className="ov-table">
            <thead>
              <tr>
                {block.head.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return (
        <div className="ov-codeblock">
          <div className="ov-codeblock-bar">
            <CodeBlockTitle title={block.title} />
            <span>{block.lang}</span>
          </div>
          <pre>
            <CodeHighlight code={block.text} lang={block.lang} />
          </pre>
        </div>
      );
    case 'detail':
      return <DetailBlock summary={block.summary} body={block.body} />;
    case 'note':
      return (
        <div className="ov-note">
          <span className="ov-note-icon">▲ NOTE</span>
          <span className="ov-note-text">{renderInline(block.text)}</span>
        </div>
      );
    case 'stats':
      return (
        <div className="ov-stats">
          {block.items.map((s) => (
            <div className="ov-stat" key={s.k}>
              <div className="ov-stat-v">{s.v}</div>
              <div className="ov-stat-k">{s.k}</div>
            </div>
          ))}
        </div>
      );
    case 'diagram':
      return <DiagramView id={block.id} />;
    case 'dbz':
      return <DbzLegend />;
  }
}

function DiagramView({ id }: { id: 'system' | 'mrms' | 'workers' | 'plate' }) {
  switch (id) {
    case 'system':
      return <SystemMap />;
    case 'mrms':
      return <MrmsPipelineDiagram />;
    case 'workers':
      return <WorkerTopologyDiagram />;
    case 'plate':
      return <PlateProjectionDiagram />;
  }
}

function SubSectionView({ sub }: { sub: SubSection }) {
  return (
    <div className="ov-sub ov-reveal" id={sub.id}>
      <div className="ov-sub-head">
        <span className="ov-sub-num">{sub.num}</span>
        <h3 className="ov-sub-title">{sub.title}</h3>
        {sub.tag && <span className="ov-sub-tag">{sub.tag}</span>}
      </div>
      {sub.blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

export default function OverviewClient() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  /* scroll spy against the page's own scroll container */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ids = SECTIONS.flatMap((s) => [s.id, ...s.subs.map((x) => x.id)]);
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        let current = ids[0];
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top <= 150) {
            current = id;
          }
        }
        setActive(current);
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => root.removeEventListener('scroll', onScroll);
  }, []);

  /* reveal-on-scroll */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('ov-in');
            observer.unobserve(entry.target);
          }
        }
      },
      { root, rootMargin: '0px 0px -6% 0px' }
    );
    root.querySelectorAll('.ov-reveal').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="ov-root" ref={rootRef}>
      <header className="ov-header">
        <a className="ov-back" href="/">
          ◀ SCENE
        </a>
        <div className="ov-header-cell ov-grow">
          <span className="ov-header-k">ApproachViz — technical briefing</span>
          <span className="ov-header-v">
            SYSTEM <span className="ov-tick">/</span> OVERVIEW
          </span>
        </div>
        <div className="ov-header-cell ov-opt">
          <span className="ov-header-k">Doc</span>
          <span className="ov-header-v">AV-OVW-1</span>
        </div>
        <div className="ov-header-cell ov-opt">
          <span className="ov-header-k">Sections</span>
          <span className="ov-header-v">{String(SECTIONS.length).padStart(2, '0')}</span>
        </div>
      </header>

      <div className="ov-hero">
        <div className="ov-kicker">Architecture briefing · continuous amendment</div>
        <h1 className="ov-title">
          System
          <br />
          <em>Overview</em>
        </h1>
        <p className="ov-lede">
          How ApproachViz turns FAA procedure data, NOAA radar mosaics and live ADS-B into a 3D
          approach picture — <strong>one Rust engine</strong>, three build targets, and clients that
          keep every heavy computation off the UI thread.
        </p>
        <div className="ov-hero-meta">
          {[
            'Next.js 16',
            'React Three Fiber',
            'Rust workspace',
            'WASM + UniFFI',
            'SwiftUI + Metal',
            'FlatBuffers wire',
            'AWS SNS/SQS',
            'SQLite'
          ].map((chip) => (
            <span className="ov-file-chip" key={chip}>
              {chip}
            </span>
          ))}
        </div>
      </div>

      <div className="ov-shell">
        <nav className="ov-rail" aria-label="Sections">
          <div className="ov-rail-title">Index</div>
          {SECTIONS.map((section) => (
            <div key={section.id}>
              <a
                className={`ov-rail-link ${active === section.id ? 'ov-active' : ''}`}
                href={`#${section.id}`}
              >
                <span className="ov-num">{section.num}</span>
                {section.title}
              </a>
              {section.subs.map((sub) => (
                <a
                  key={sub.id}
                  className={`ov-rail-link ov-rail-sub ${active === sub.id ? 'ov-active' : ''}`}
                  href={`#${sub.id}`}
                >
                  <span className="ov-num">{sub.num}</span>
                  {sub.title}
                </a>
              ))}
            </div>
          ))}
        </nav>

        <main className="ov-main">
          {SECTIONS.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="ov-section"
              style={{ '--accent': section.accent } as CSSProperties}
            >
              <div className="ov-section-strip">
                <span className="ov-section-num">SEC {section.num}</span>
                <h2 className="ov-section-title">{section.title}</h2>
                <span className="ov-section-tag">{section.tag}</span>
              </div>
              <p className="ov-section-intro">{renderInline(section.intro)}</p>
              {section.subs.map((sub) => (
                <SubSectionView key={sub.id} sub={sub} />
              ))}
            </section>
          ))}

          <footer className="ov-footer">
            <span>ApproachViz · System Overview — compiled from source + AGENTS.md</span>
            <span>Not for navigation</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
