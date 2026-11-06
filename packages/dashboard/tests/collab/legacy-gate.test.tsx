import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach,describe,expect,it,vi } from 'vitest';

vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),usePathname:()=>'/agents'}));
import { LegacyAdminGate } from '@/components/layout/legacy-admin-gate';

afterEach(()=>vi.unstubAllGlobals());

describe('legacy surface server rendering',()=>{
  it('creates the session provider before reading identity and withholds content while loading',()=>{
    vi.stubGlobal('React',React);
    let html='';
    expect(()=>{html=renderToStaticMarkup(<LegacyAdminGate><div>Private legacy content</div></LegacyAdminGate>);}).not.toThrow();
    expect(html).toContain('Loading');
    expect(html).not.toContain('Private legacy content');
  });
});
