import { Router } from "express";
import { startOauth } from "./connectors/oauth/init.js";
import { callbackOauth } from "./connectors/oauth/callbackHandler.js";

const router = Router();

/*
=============================== OAUTH ENDPOINTS ================================
/oauth/start    -> user clicks Connect; state token arrives here.
                   We resolve the app, build the provider auth URL, redirect.
/oauth/callback -> provider posts code + state back here.
                   We exchange code for tokens, store them, mark connection ACTIVE.
*/

router.get("/oauth/start", (req, res) => {
  startOauth(req.query.state, res);
});

router.get("/oauth/callback", (req, res) => {
  callbackOauth(req.query.code, req.query.state, res);
});

export default router;
