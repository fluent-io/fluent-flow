import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach,describe,expect,it,vi } from 'vitest';

vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),usePathname:()=>'/agents'}));
import { InternalNavGate } from '@/components/layout/internal-nav-gate';

afterEach(()=>vi.unstubAllGlobals());

describe('internal nav gate server rendering',()=>{
  it('creates the session provider before reading identity and withholds content while loading',()=>{
    vi.stubGlobal('React',React);
    let html='';
    expect(()=>{html=renderToStaticMarkup(<InternalNavGate><div>Private internal content</div></InternalNavGate>);}).not.toThrow();
    expect(html).toContain('Loading');
    expect(html).not.toContain('Private internal content');
  });
});
