import type { RouteObject } from 'react-router-dom';
import DreamRoom from '@/components/DreamRoom';

// DreamRoom is the only production shell.  Legacy demo/debug pages are not
// referenced here, so Vite cannot silently ship their remote sample assets or
// large unrelated feature chunks in the desktop product.
const rootRouter: RouteObject[] = [
  { path: '/', element: <DreamRoom /> },
  { path: '/reverie', element: <DreamRoom /> },
  { path: '*', element: <DreamRoom /> },
];

export default rootRouter;
