import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    try {
      void supabase.auth
        .getSession()
        .then(({ data }) => {
          if (!active) return;
          setSession(data.session);
          setLoading(false);
        })
        .catch(() => {
          if (!active) return;
          setSession(null);
          setLoading(false);
        });

      const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
        if (!active) return;
        setSession(next);
        setLoading(false);
      });
      unsubscribe = () => sub.subscription.unsubscribe();
    } catch {
      // A temporarily stale preview binding must not take down public pages.
      setSession(null);
      setLoading(false);
    }

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return { session, user: session?.user ?? null, loading };
}
