import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, has, useLoad } from './api.ts';
import { Home } from './Home.tsx';
import { JobPage } from './JobPage.tsx';
import { OrderPage } from './OrderPage.tsx';
import { ProofPage } from './ProofPage.tsx';
import { BoardPage } from './BoardPage.tsx';
import { CrewPage } from './CrewPage.tsx';
import { AgentPage } from './AgentPage.tsx';
import { CREW } from './team.ts';
import { Footer, Nav, Off } from './parts.tsx';
import { usePath } from './router.tsx';
import './styles.css';

// Enlisted agents' names, so bids and steps show them by name anywhere on the site.
const crewNames = api.crew().then((c) => c.crew.forEach((m) => { CREW[m.slug] = m.name; })).catch(() => {});

function App() {
  const path = usePath();
  const info = useLoad(api.info);
  // draw again once the names are in: a finished job's page doesn't refresh on its own
  const [, named] = useState(false);
  useEffect(() => { void crewNames.then(() => named(true)); }, []);
  const order = path.match(/^\/order\/([\w-]+)/), job = path.match(/^\/job\/([a-z0-9]+)/), agent = path.match(/^\/agent\/([a-z0-9._-]+)/);
  return (
    <>
      <Nav info={info} />
      {order ? <OrderPage id={order[1]} info={info} /> : agent ? <AgentPage account={agent[1]} info={info} /> : job ? <JobPage id={job[1]} info={info} /> : path === '/proof' ? <ProofPage /> : path === '/crew' ? (has(info, 'crew') ? <CrewPage info={info} /> : <Off what="the open crew" />) : path === '/board' ? (has(info, 'board') ? <BoardPage info={info} /> : <Off what="the board" />) : <Home info={info} />}
      <Footer info={info} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
