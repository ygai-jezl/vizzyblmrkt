"use client";

import { useEffect, useRef } from "react";
import type { StepHead } from "@/lib/site/content";
import { createWalkthrough } from "./engine/walkthrough";

export interface WalkStep {
  tab: string;
  title: string;
  desc: string;
  dur: number;
  head: StepHead[];
  scene: string;
}

export interface WalkthroughProps {
  ariaLabel: string;
  steps: WalkStep[];
  obj: { id: string; via: string; named: string; placeholder: string };
  pipe: string[];
  stepText: string[];
  labels: { pause: string; play: string; next: string; workspace: string };
}

/**
 * A feature's five-step walkthrough. The server renders every step's words (the
 * first one showing) and the product mock; the engine then plays it. The mock is
 * static HTML from src/lib/site/content.json (our own content, made-up data).
 */
export function Walkthrough(p: WalkthroughProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    return createWalkthrough(root.current, {
      steps: p.steps.map((s) => ({ dur: s.dur, head: s.head })),
      named: p.obj.named,
      placeholder: p.obj.placeholder,
      stepText: p.stepText,
      labels: p.labels,
    });
  }, [p]);
  const first = p.steps[0]?.head[0];
  return (
    <div ref={root}>
      <div className="tabs" role="tablist" aria-label={p.ariaLabel}>
        {p.steps.map((s, k) => (
          <button key={k} className="tab" type="button" role="tab" id={`wtab-${k}`} aria-controls="wPanel" aria-selected={k === 0} tabIndex={k === 0 ? 0 : -1}>
            <span className="bar"><i /></span>
            <span className="num">{k + 1}</span>
            <span className="lab">{s.tab}</span>
          </button>
        ))}
      </div>
      <div className="panel" id="wPanel" role="tabpanel" aria-labelledby="wtab-0">
        <div className="p-text" aria-live="polite">
          <span className="p-step">{p.stepText[0]}</span>
          {p.steps.map((s, k) => (
            <div key={k} className="p-copy" hidden={k !== 0}>
              <h3 className="p-title">{s.title}</h3>
              <p className="p-desc">{s.desc}</p>
            </div>
          ))}
          <button className="pp" type="button">{p.labels.pause}</button>
        </div>
        <div className="frame">
        <span className="frame-tag" aria-hidden="true"><svg><use href="#loopmark" /></svg>{p.labels.workspace}</span>
        <div className="board" lang="en" aria-hidden="true">
          <div className="b-head">
            <div className="card idea">
              <div className="idea-top">
                <span>{p.obj.id}</span>
                <span className="via"><svg><use href="#loopmark" /></svg>{p.obj.via}</span>
                <span className="pill" data-t={first?.[2]}>{first?.[1]}</span>
              </div>
              <div className={first?.[4] ? "idea-t" : "idea-t ph"}>{first?.[4] ? p.obj.named : p.obj.placeholder}</div>
            </div>
            <ol className="pipe">{p.pipe.map((x) => <li key={x}>{x}</li>)}</ol>
          </div>
          <div className="scenes">
            {p.steps.map((s, k) => (
              <div key={k} className={k === 0 ? "scene active" : "scene"} data-scene={k} dangerouslySetInnerHTML={{ __html: s.scene }} />
            ))}
          </div>
        </div>
        <div className="frame-dots" aria-hidden="true">{p.steps.map((_, k) => <i key={k} className={k === 0 ? "on" : undefined} />)}</div>
        </div>
      </div>
    </div>
  );
}
