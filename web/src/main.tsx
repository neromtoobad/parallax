import { createRoot } from 'react-dom/client';
import { api, useLoad } from './api.ts';
import { Home } from './Home.tsx';
import { JobPage } from './JobPage.tsx';
import { OrderPage } from './OrderPage.tsx';
import { ProofPage } from './ProofPage.tsx';
import { CrewPage } from './CrewPage.tsx';
import { CREW } from './team.ts';
import { Footer, Nav } from './parts.tsx';
import { usePath } from './router.tsx';
import './styles.css';

// Enlisted agents' names, so bids and steps show them by name anywhere on the site.
api.crew().then((c) => c.crew.forEach((m) => { CREW[m.slug] = m.name; })).catch(() => {});

function App() {
  const path = usePath();
  const info = useLoad(api.info);
  const order = path.match(/^\/order\/([\w-]+)/), job = path.match(/^\/job\/([a-z0-9]+)/);
  return (
    <>
      <Nav info={info} />
      {order ? <OrderPage id={order[1]} info={info} /> : job ? <JobPage id={job[1]} info={info} /> : path === '/proof' ? <ProofPage /> : path === '/crew' ? <CrewPage info={info} /> : <Home info={info} />}
      <Footer info={info} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
