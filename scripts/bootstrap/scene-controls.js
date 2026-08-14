/** Add the single role-aware Infinity launcher to Foundry scene controls. */
export function applyInfinitySceneControls(controls, bindings) {
  const launcherToolName = "infinity-dnd5e-launcher";
  const fullGm = bindings.isFullGM?.() === true;
  const launcherTitle = fullGm
    ? "Open Infinity Game Master Workbench"
    : "Open Infinity Player Launcher";
  const categoryTitle = fullGm
    ? "Infinity Game Master Workbench"
    : "Infinity D&D5e";
  const baseTool = {
    title: launcherTitle,
    icon: "fa-solid fa-dice-d20",
    button: true,
    visible: true,
    toggle: false,
    onChange: () => bindings.openHub(),
  };
  const onCategoryChange = (_event, active) => {
    if (active) bindings.openHub();
  };
  const buildTool = (name, title, order) => ({
    ...baseTool,
    name,
    title,
    order,
  });

  const shape = Array.isArray(controls)
    ? `Array(${controls.length})`
    : controls && typeof controls === "object"
      ? `Record(${Object.keys(controls).length})`
      : typeof controls;
  bindings.logger.log(
    `${bindings.moduleId} | scene-controls hook fired, shape=${shape}`,
  );

  try {
    if (Array.isArray(controls)) {
      if (!controls.some((control) => control?.name === bindings.moduleId)) {
        controls.push({
          name: bindings.moduleId,
          title: categoryTitle,
          icon: "fa-solid fa-dice-d20",
          visible: true,
          activeTool: launcherToolName,
          order: 99,
          onChange: onCategoryChange,
          tools: [buildTool(launcherToolName, baseTool.title, 0)],
        });
      }
      bindings.logger.log(
        `${bindings.moduleId} | registered V12 role-aware launcher control`,
      );
      return true;
    }

    if (controls && typeof controls === "object") {
      controls[bindings.moduleId] = {
        name: bindings.moduleId,
        title: categoryTitle,
        icon: "fa-solid fa-dice-d20",
        visible: true,
        activeTool: launcherToolName,
        order: 99,
        onChange: onCategoryChange,
        tools: {
          [launcherToolName]: buildTool(launcherToolName, baseTool.title, 0),
        },
      };
      bindings.logger.log(
        `${bindings.moduleId} | registered V13 role-aware launcher control`,
      );
      return true;
    }

    bindings.logger.warn(
      `${bindings.moduleId} | scene-controls payload was neither Array nor Object (got ${typeof controls}); skipping launcher registration`,
    );
    return false;
  } catch (error) {
    bindings.logger.error(
      `${bindings.moduleId} | scene-controls registration failed`,
      error,
    );
    return false;
  }
}
