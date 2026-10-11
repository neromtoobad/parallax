'use client';

import { AGENT_IDS, CAST, STATIONS, sprite, type AgentState, type Pose } from '@/lib/cast';

export { AGENT_IDS, CAST, STATIONS, sprite };
export type { AgentState, Pose };

/** The illustrated observatory with the team in it. Pure view: the caller decides poses and bubbles. */
export function Studio({ states = {}, tags = false, className = '' }: { states?: Partial<Record<keyof typeof STATIONS, AgentState>>; tags?: boolean; className?: string }) {
  return (
    <div className={`studio ${className}`}>
      <img className="scene" src="/studio.webp" alt="The Parallax observatory: an archive, a field room, an arbiter's bench, an inspection desk, a vault and a writing nook under a dome with two telescopes on one star" />
      {AGENT_IDS.map((a) => {
        const st = states[a] ?? { pose: 'idle' as Pose };
        const pos = STATIONS[a];
        return (
          <div
            key={a}
            className={`agent ${st.on ? 'on' : ''} ${st.dim ? 'dim' : ''}`}
            style={{ left: `${pos.x}%`, top: `${pos.y}%`, height: '21.2%', ['--c' as any]: CAST[a].color, zIndex: st.on ? 4 : 2 }}
            title={`${CAST[a].name}: ${CAST[a].role}`}
          >
            {st.on && <span className="halo" />}
            {st.bubble && (
              <div className="bubble" key={st.bubble}>
                <b>{CAST[a].name}</b> {st.bubble}
              </div>
            )}
            <img src={sprite(a, st.pose)} alt={`${CAST[a].name}, ${st.pose}`} />
            {tags && <span className="nametag">{CAST[a].name}</span>}
          </div>
        );
      })}
    </div>
  );
}
