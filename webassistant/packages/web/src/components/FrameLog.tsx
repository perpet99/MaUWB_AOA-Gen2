/**
 * The decoded frame stream, newest last -- the browser equivalent of
 * `mauwb_cli.py sniff`.
 *
 * Config frames are what you actually read when talking to a device, so they
 * always show their text and hex. Positioning frames are summarised on one line
 * unless raw capture is on.
 */

import { useEffect, useRef } from 'react';
import {
  anchorValid,
  batteryVolts,
  devTypeName,
  hex16,
  tagFlags,
  type WireFrame,
} from '@mauwb/protocol';

interface Props {
  frames: WireFrame[];
  follow: boolean;
  showLoc: boolean;
}

const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

function summarize(f: WireFrame): string {
  if (f.kind === 'loc') {
    const parts = [
      `anc=${hex16(f.ancAddr16)}`,
      `tag=${hex16(f.tagAddr16)}`,
      `sn=${String(f.tagSn).padStart(3)}`,
    ];
    for (const a of f.anchors) {
      if (!anchorValid(a)) continue;
      let s = `A${a.index}:${sign(a.angleDeg)}° ${a.rangeCm}cm`;
      if (a.rssi !== null) s += ` ${sign(a.rssi)}dBm`;
      parts.push(s);
    }
    parts.push(`${batteryVolts(f.detail).toFixed(2)}V`);
    parts.push(devTypeName(f.detail));
    const fl = tagFlags(f.detail);
    if (fl.length) parts.push(`[${fl.join(',')}]`);
    return parts.join('  ');
  }
  if (f.kind === 'config') return JSON.stringify(f.text);
  return f.payload;
}

export function FrameLog({ frames, follow, showLoc }: Props) {
  const ref = useRef<HTMLPreElement>(null);
  const visible = showLoc ? frames : frames.filter((f) => f.kind !== 'loc');

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });

  if (!visible.length) {
    return (
      <div className="empty">
        {showLoc ? 'Nothing decoded yet.' : 'No config or OTA frames yet — only positioning traffic.'}
      </div>
    );
  }

  return (
    <pre className="log" ref={ref}>
      {visible.map((f, i) => {
        const t = new Date(f.hostTime);
        const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(
          t.getSeconds(),
        ).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
        return (
          <div key={`${f.hostTime}-${i}`}>
            <span className="t">{clock} </span>
            <span className={f.kind}>
              {f.cmdTypeName}/{f.cmdDirectName}
            </span>{' '}
            {summarize(f)}
            {f.raw ? <div className="t">  {f.raw}</div> : null}
          </div>
        );
      })}
    </pre>
  );
}
