import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard.js";
import { NewProject } from "./NewProject.js";
import { ProjectDetailView } from "./ProjectDetail.js";

function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const projectMatch = /^\/projects\/([\w-]+)$/.exec(route);

  let page;
  if (route === "/new") page = <NewProject />;
  else if (projectMatch) page = <ProjectDetailView id={projectMatch[1]} />;
  else page = <Dashboard />;

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          OrchestrAI <span className="muted">control center</span>
        </a>
        <nav>
          <a href="#/">Dashboard</a>
          <a href="#/new" className="button primary">
            New project
          </a>
        </nav>
      </header>
      <main>{page}</main>
    </div>
  );
}
