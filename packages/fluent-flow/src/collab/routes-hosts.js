import { Router } from 'express';
import {
  createExecutionHost,
  createProjectHostMapping,
  listExecutionHosts,
  listProjectHostMappings,
  revokeExecutionHost,
} from '@fluent-flow/db';

/**
 * Host administration routes (contract: GET/POST /hosts, POST
 * /hosts/:id/revoke, GET/POST /projects/:id/mappings). Authority is the
 * ENROLLING principal or a genuine superadmin — unrelated org admins get 404
 * indistinguishable from missing hosts.
 */
export function registerHostRoutes(router) {
  router.get('/hosts', async (req, res, next) => {
    try {
      res.json({ data: await listExecutionHosts(req.collabActor) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/hosts', async (req, res, next) => {
    try {
      const host = await createExecutionHost({ actor: req.collabActor, name: req.body?.name });
      res.status(201).json({ data: host });
    } catch (err) {
      next(err);
    }
  });

  router.post('/hosts/:id/revoke', async (req, res, next) => {
    try {
      await revokeExecutionHost({ actor: req.collabActor, hostId: req.params.id });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:id/mappings', async (req, res, next) => {
    try {
      res.json({ data: await listProjectHostMappings(req.collabActor, req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:id/mappings', async (req, res, next) => {
    try {
      const mapping = await createProjectHostMapping({
        actor: req.collabActor,
        projectId: req.params.id,
        hostId: req.body?.hostId,
        repositoryKey: req.body?.repositoryKey,
        baseRef: req.body?.baseRef,
        profileIds: req.body?.profileIds,
        defaultProfileId: req.body?.defaultProfileId,
      });
      res.status(201).json({ data: mapping });
    } catch (err) {
      next(err);
    }
  });
}
