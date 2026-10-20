import {
  addCollabMember,
  bootstrapCollaborationWorkspace,
  createCollabInvitation,
  createCollabProject,
  getCollabBootstrapEligibility,
  updateProjectExecutionDefaults,
  getPrincipalMeProfile,
  removeCollabMember,
  requireCurrentPrincipal,
  revokeCollabInvitation,
  listCollabInvitations,
  createWorkspaceRole,
  listWorkspaceRoles,
  updateCollabMemberRole,
  CollabServiceError,
  createCollabProjectToken,
  listCollabProjectTokens,
  revokeCollabProjectToken,
  listCollabMembers,
  listCollabAssignees,
} from '@fluent-flow/db';

/**
 * Authenticated identity/workspace/membership routes. Handlers trust
 * req.collabActor only after requireActor; every service call re-checks the
 * current principal, membership and capabilities in the DB.
 */
export function registerIdentityRoutes(router) {
  router.get('/projects/:id/assignees',async(req,res,next)=>{
    try {res.json({data:await listCollabAssignees({actor:req.collabActor,projectId:req.params.id})});}catch(err){next(err);}
  });
  router.get('/projects/:id/tokens',async(req,res,next)=>{
    try { res.json({data:await listCollabProjectTokens({actor:req.collabActor,projectId:req.params.id})}); } catch(err){next(err);}
  });
  router.post('/projects/:id/tokens',async(req,res,next)=>{
    try { res.status(201).json({data:await createCollabProjectToken({actor:req.collabActor,projectId:req.params.id,name:req.body?.name})}); } catch(err){next(err);}
  });
  router.post('/tokens/:id/revoke',async(req,res,next)=>{
    try { await revokeCollabProjectToken({actor:req.collabActor,tokenId:req.params.id});res.status(204).end(); } catch(err){next(err);}
  });
  router.get('/me', async (req, res, next) => {
    try {
      const principal = await requireCurrentPrincipal(req.collabActor);
      const profile = await getPrincipalMeProfile(principal.id);
      // Authoritative from legacy DB roles (workspace admins' org picker);
      // non-GitHub principals resolve to {eligible:false, legacyOrgIds:[]}.
      const bootstrap = await getCollabBootstrapEligibility(req.collabActor);
      res.json({
        data: {
          principal,
          workspaces: profile.workspaces,
          capabilities: profile.capabilities,
          workspaceCapabilities: profile.workspaceCapabilities,
          bootstrap,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/workspaces', async (req, res, next) => {
    try {
      const principal = await requireCurrentPrincipal(req.collabActor);
      const profile = await getPrincipalMeProfile(principal.id);
      res.json({ data: profile.workspaces });
    } catch (err) {
      next(err);
    }
  });

  router.post('/workspaces', async (req, res, next) => {
    try {
      const principal = await requireCurrentPrincipal(req.collabActor);
      const eligibility = await getCollabBootstrapEligibility(req.collabActor);
      if (!eligibility.eligible) {
        throw new CollabServiceError(
          403,
          'bootstrap_not_allowed',
          'You do not have permission to perform this action.',
        );
      }
      const legacyOrgId = req.body?.legacyOrgId ?? undefined;
      if (legacyOrgId !== undefined && !eligibility.legacyOrgIds.includes(legacyOrgId)) {
        throw new CollabServiceError(
          403,
          'bootstrap_not_allowed',
          'You do not have permission to perform this action.',
        );
      }
      const resolvedOrg =
        legacyOrgId ??
        (eligibility.legacyOrgIds.length === 1
          ? eligibility.legacyOrgIds[0]
          : null);
      if (!resolvedOrg) {
        throw new CollabServiceError(
          422,
          'select_organization',
          'Choose which organization this workspace belongs to.',
        );
      }
      // Deterministic default makes operator retries idempotent without a
      // client-generated key.
      const idempotencyKey =
        typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.length >= 8
          ? req.body.idempotencyKey
          : `ws:${principal.id}:${resolvedOrg}`;
      const workspace = await bootstrapCollaborationWorkspace({
        actor: req.collabActor,
        legacyOrgId: resolvedOrg,
        name: req.body?.name,
        idempotencyKey,
      });
      res.status(201).json({ data: workspace });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/projects/:id', async (req, res, next) => {
    try {
      const project = await updateProjectExecutionDefaults({
        actor: req.collabActor,
        projectId: req.params.id,
        expectedVersion: req.body?.expectedVersion,
        executionDefaults: req.body?.executionDefaults,
      });
      res.json({ data: project });
    } catch (err) {
      next(err);
    }
  });

  router.get('/workspaces/:id/roles', async (req, res, next) => {
    try {
      res.json({ data: await listWorkspaceRoles({ actor: req.collabActor, workspaceId: req.params.id, projectId: req.query.projectId }) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/workspaces/:id/roles', async (req, res, next) => {
    try {
      const role = await createWorkspaceRole({
        actor: req.collabActor,
        workspaceId: req.params.id,
        name: req.body?.name,
        capabilities: req.body?.capabilities,
      });
      res.status(201).json({ data: role });
    } catch (err) {
      next(err);
    }
  });

  const listInvitations = (scopeParam) => async (req, res, next) => {
    try {
      const invitations = await listCollabInvitations({
        actor: req.collabActor,
        workspaceId: scopeParam === 'workspace' ? req.params.id : undefined,
        projectId: scopeParam === 'project' ? req.params.id : null,
      });
      res.json({ data: invitations });
    } catch (err) {
      next(err);
    }
  };
  router.get('/workspaces/:id/invitations', listInvitations('workspace'));
  router.get('/projects/:id/invitations', listInvitations('project'));

  router.post('/invitations/:id/revoke', async (req, res, next) => {
    try {
      await revokeCollabInvitation({ actor: req.collabActor, invitationId: req.params.id });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get('/workspaces/:id/projects', async (req, res, next) => {
    try {
      const principal = await requireCurrentPrincipal(req.collabActor);
      const profile = await getPrincipalMeProfile(principal.id);
      const workspace = profile.workspaces.find(item => item.id === req.params.id);
      if (!workspace) throw new CollabServiceError(404, 'not_found', 'Not found.');
      res.json({ data: workspace.projects });
    } catch (err) {
      next(err);
    }
  });

  router.post('/workspaces/:id/projects', async (req, res, next) => {
    try {
      const project = await createCollabProject({
        actor: req.collabActor,
        workspaceId: req.params.id,
        name: req.body?.name,
      });
      res.status(201).json({ data: project });
    } catch (err) {
      next(err);
    }
  });

  const createInvitation = (scopeParam) => async (req, res, next) => {
    try {
      const invitation = await createCollabInvitation({
        actor: req.collabActor,
        workspaceId: scopeParam === 'workspace' ? req.params.id : req.body?.workspaceId,
        projectId: scopeParam === 'project' ? req.params.id : null,
        email: req.body?.email,
        roleId: req.body?.roleId,
        expiresInHours: req.body?.expiresInHours,
      });
      res.status(201).json({ data: invitation });
    } catch (err) {
      next(err);
    }
  };
  router.post('/workspaces/:id/invitations', createInvitation('workspace'));
  router.post('/projects/:id/invitations', createInvitation('project'));

  router.post('/:scope(workspaces|projects)/:id/members', async (req, res, next) => {
    try {
      const membership = await addCollabMember({
        actor: req.collabActor,
        workspaceId: req.params.scope === 'workspaces' ? req.params.id : undefined,
        projectId: req.params.scope === 'projects' ? req.params.id : null,
        principalId: req.body?.principalId,
        roleId: req.body?.roleId,
      });
      res.status(201).json({ data: membership });
    } catch (err) {
      next(err);
    }
  });
  router.get('/:scope(workspaces|projects)/:id/members',async(req,res,next)=>{
    try {
      const result=await listCollabMembers({actor:req.collabActor,workspaceId:req.params.scope==='workspaces'?req.params.id:undefined,projectId:req.params.scope==='projects'?req.params.id:null,cursor:req.query.cursor||undefined,limit:Number(req.query.limit??100)});
      res.json({data:result.members,nextCursor:result.nextCursor});
    } catch(err){next(err);}
  });

  router.patch('/:scope(workspaces|projects)/:id/members/:principalId', async (req, res, next) => {
    try {
      const membership = await updateCollabMemberRole({
        actor: req.collabActor,
        workspaceId: req.params.scope === 'workspaces' ? req.params.id : undefined,
        projectId: req.params.scope === 'projects' ? req.params.id : null,
        principalId: req.params.principalId,
        roleId: req.body?.roleId,
        expectedVersion: req.body?.expectedVersion,
      });
      res.json({ data: membership });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:scope(workspaces|projects)/:id/members/:principalId', async (req, res, next) => {
    try {
      await removeCollabMember({
        actor: req.collabActor,
        workspaceId: req.params.scope === 'workspaces' ? req.params.id : undefined,
        projectId: req.params.scope === 'projects' ? req.params.id : null,
        principalId: req.params.principalId,
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });
}
