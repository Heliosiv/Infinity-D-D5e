/** Infinity D&D5e — sole Foundry ESM entry point. */
import { createModuleBootstrap } from "./bootstrap/lifecycle.js";
import { runtimeBindings } from "./bootstrap/runtime.js";

createModuleBootstrap(runtimeBindings).register();
