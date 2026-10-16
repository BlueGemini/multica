"use client";

import { useEffect } from "react";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../../navigation";

/**
 * `/agents/new/**` was the old creation route. Creating is now a dialog over
 * the agents list; restored desktop tabs and old links land here and are
 * forwarded with the params that still mean something.
 */
export function LegacyCreateAgentRedirect() {
  const paths = useWorkspacePaths();
  const { searchParams, replace } = useNavigation();
  const squad = searchParams.get("squad");
  const duplicate = searchParams.get("duplicate");
  useEffect(() => {
    replace(paths.createAgent({ squad, duplicate }));
  }, [duplicate, paths, replace, squad]);
  return null;
}
