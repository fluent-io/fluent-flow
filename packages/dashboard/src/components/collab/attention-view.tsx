'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { LatestRequest,pollResource } from '@/lib/collab/live';
import { ApiError, collabFetch } from '@/lib/collab/api';
import type { AttentionItem } from '@/lib/collab/types';

const KIND_LABEL: Record<string, string> = {
  question: 'Agent question',
  permission: 'Permission request',
  error: 'Execution error',
  unread: 'New activity',
  attention: 'Needs attention',
};
const PAGES_PER_LOAD = 20;

export function AttentionView() {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const requests=useRef(new LatestRequest());
  const pageBudget=useRef(PAGES_PER_LOAD);
  const load=useCallback(async(parent?:AbortSignal)=>{
    const signal=requests.current.begin(parent);
    setLoading(true);
    try{
      const collected=new Map<string,AttentionItem>();
      const seenCursors=new Set<string>();
      let cursor:string|null=null;
      let repeatedCursor=false;
      for(let page=0;page<pageBudget.current;page++){
        seenCursors.add(cursor??'');
        const params=new URLSearchParams({limit:'100'});
        if(cursor)params.set('cursor',cursor);
        const result=await collabFetch<AttentionItem[]>(`/attention?${params}`,{signal});
        if(!requests.current.current(signal))return;
        for(const item of result.data)if(!collected.has(item.id))collected.set(item.id,item);
        cursor=result.nextCursor;
        if(!cursor)break;
        if(seenCursors.has(cursor)){repeatedCursor=true;break;}
      }
      if(requests.current.current(signal)){
        setItems([...collected.values()]);
        setHasMore(Boolean(cursor)&&!repeatedCursor);
        setError(repeatedCursor?'Some attention items could not be loaded. Refresh to try again.':null);
      }
    }catch(error){
      if(requests.current.current(signal)){
        if(error instanceof ApiError&&[401,403,404].includes(error.status)){
          setItems([]);setHasMore(false);setError('Attention access is no longer available.');
        }else setError('Attention updates are temporarily unavailable. Showing last observed items.');
      }
    }
    finally{if(requests.current.current(signal))setLoading(false);}
  },[]);
  useEffect(()=>{const stop=pollResource(load);return()=>{stop();requests.current.dispose();};},[load]);

  async function markRead(item: AttentionItem) {
    try {
      await collabFetch(`/tasks/${item.taskId}/read-cursor`, {
        method: 'POST',
        body: { eventId: item.id },
      });
      await load();
    } catch {
      // Unresolved approvals/errors cannot be cleared by the read cursor; the
      // server rejects that and the item stays.
      await load();
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Needs attention</h1>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{error}</p> : null}
      {loading && items.length === 0 ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {items.length === 0 && !loading && !error ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Nothing needs your attention right now.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded border border-orange-500/40 bg-orange-500/10 px-1.5 py-0.5 text-[11px] text-orange-600 dark:text-orange-400">
                    {KIND_LABEL[item.kind] ?? item.kind}
                  </span>
                  <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-sm font-medium">{item.title}</p>
                {item.detail ? <p className="text-xs text-muted-foreground">{item.detail}</p> : null}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/tasks/${item.taskId}`}>Open task</Link>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void markRead(item)}>
                  Mark read
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
          <p>More attention items are available.</p>
          <Button variant="outline" size="sm" disabled={loading} onClick={()=>{pageBudget.current+=PAGES_PER_LOAD;void load();}}>Load more</Button>
        </div>
      ) : null}
    </div>
  );
}
