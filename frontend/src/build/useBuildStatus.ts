/**
 * What is running, and whether it is older than the code on disk.
 *
 * Two sources: GET /api/build (the commit the API process started from) and
 * GET /__build (answered by the Vite server, which can see the repo). A static
 * host has neither the second endpoint nor usually the first; both failures
 * leave the stamp showing the bundle's own commit and the check silent.
 */

import { useCallback, useEffect, useState } from "react";

import type { BuildVerdict } from "./classify";

export const BUILD: { sha: string | null; branch: string | null; builtAt: number } =
  typeof __BUILD__ !== "undefined" ? __BUILD__ : { sha: null, branch: null, builtAt: 0 };

export interface ApiBuild {
  sha: string | null;
  branch: string | null;
  started_at: number;
}

export interface DiskReport {
  head: string | null;
  branch: string | null;
  mode: "dev" | "preview";
  ui: BuildVerdict;
  api: BuildVerdict;
}

/** Re-checked this often, and whenever the tab regains focus — which is the
 *  moment someone comes back from running `git pull` in a terminal. */
const POLL_MS = 60_000;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function useBuildStatus() {
  const [api, setApi] = useState<ApiBuild | null>(null);
  const [disk, setDisk] = useState<DiskReport | null>(null);

  const check = useCallback(async () => {
    const apiBuild = await getJson<ApiBuild>("/api/build");
    setApi(apiBuild);
    const params = new URLSearchParams({ since: String(BUILD.builtAt) });
    if (BUILD.sha) params.set("ui", BUILD.sha);
    if (apiBuild?.sha) params.set("api", apiBuild.sha);
    setDisk(await getJson<DiskReport>(`/__build?${params.toString()}`));
  }, []);

  useEffect(() => {
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);

  return { ui: BUILD, api, disk };
}
