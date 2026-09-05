/** Existing injury records. These never authorize dice, treatment, or effect changes. */
export const RECORDED_INJURY_FLAG = "recordedInjuries";
const MODULE_ID = "infinity-dnd5e";
const STATES = ["active", "permanent", "recovered", "review"];
const UUID =
  /^(Actor\.[A-Za-z0-9]{16}(\.ActiveEffect\.[A-Za-z0-9]{16})?|JournalEntry\.[A-Za-z0-9]{16})$/;
const clone = (value) => JSON.parse(JSON.stringify(value));
const plain = (value, max) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw new Error("RecordedInjuryInvalidText");
  return value.trim();
};
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const source = (doc) => doc?.toObject?.() ?? doc;
const values = (collection) =>
  Array.from(
    collection?.contents ?? collection?.values?.() ?? collection ?? [],
  );

export function getRecordedInjuryRows(actor) {
  const entries = actor?.flags?.[MODULE_ID]?.[RECORDED_INJURY_FLAG] ?? {};
  return Object.values(entries)
    .filter(
      (r) =>
        r?.schema === 1 &&
        r.actorUuid === actor.uuid &&
        STATES.includes(r.status) &&
        typeof r.label === "string",
    )
    .slice(0, 100)
    .map((r) => ({
      id: r.id,
      name: r.label.slice(0, 200),
      status: r.status,
      recovery: `${r.status === "review" ? "Needs review" : r.status === "recovered" ? "Recovered" : r.status === "permanent" ? "Permanent" : "Active"}${r.calendarLabel ? ` · ${String(r.calendarLabel).slice(0, 150)}` : ""}`,
      notes: String(r.notes ?? "").slice(0, 3000),
      calendarUuid: /^JournalEntry\.[A-Za-z0-9]{16}$/.test(r.calendarUuid)
        ? r.calendarUuid
        : null,
    }));
}

export function normalizeRecordedInjury(input) {
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          "actorUuid",
          "sourceUuid",
          "label",
          "status",
          "notes",
          "calendarUuid",
          "date",
          "dateMeaning",
          "reason",
        ].includes(k),
    )
  )
    throw new Error("RecordedInjuryUnknownField");
  const actorUuid = String(input.actorUuid ?? "");
  const sourceUuid = String(input.sourceUuid ?? "");
  if (
    !/^Actor\.[A-Za-z0-9]{16}$/.test(actorUuid) ||
    !UUID.test(sourceUuid) ||
    sourceUuid === actorUuid ||
    (sourceUuid.startsWith("Actor.") &&
      !sourceUuid.startsWith(`${actorUuid}.ActiveEffect.`))
  )
    throw new Error("RecordedInjuryInvalidSource");
  if (!STATES.includes(input.status))
    throw new Error("RecordedInjuryInvalidStatus");
  const calendarUuid = input.calendarUuid || null;
  if (calendarUuid && !/^JournalEntry\.[A-Za-z0-9]{16}$/.test(calendarUuid))
    throw new Error("RecordedInjuryInvalidCalendar");
  if (!calendarUuid && !input.date)
    throw new Error("RecordedInjuryDateRequired");
  if (calendarUuid && input.date)
    throw new Error("RecordedInjuryExistingDatePreserved");
  const dateMeaning = input.dateMeaning;
  if (
    !["injury", "recovery", "recorded", "historical"].includes(dateMeaning) ||
    (dateMeaning === "historical" && !calendarUuid) ||
    (input.status === "permanent" && dateMeaning === "recovery")
  )
    throw new Error("RecordedInjuryInvalidDateMeaning");
  let date = null;
  if (input.date) {
    if (
      Object.keys(input.date).some((k) => !["year", "month", "day"].includes(k))
    )
      throw new Error("RecordedInjuryInvalidDate");
    date = Object.fromEntries(
      ["year", "month", "day"].map((k) => [k, input.date[k]]),
    );
    if (
      Object.values(date).some((v) => !Number.isSafeInteger(v)) ||
      date.month < 0 ||
      date.day < 0
    )
      throw new Error("RecordedInjuryInvalidDate");
  }
  return {
    actorUuid,
    sourceUuid,
    label: plain(input.label, 200),
    status: input.status,
    notes: plain(input.notes, 3000),
    calendarUuid,
    date,
    dateMeaning,
    reason: plain(input.reason, 1000),
  };
}

/** Dependency injection keeps the actual transaction executable in tests. */
export function createRecordedInjuryApi(env) {
  const previews = new Map();
  const completed = new Map();
  let inFlight = false;
  const hash =
    env.hash ??
    (async (value) =>
      Array.from(
        new Uint8Array(
          await globalThis.crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(value)),
          ),
        ),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""));
  const now = () => env.now?.() ?? Date.now();
  const guard = async (write = false) => {
    if (!env.isFullGM()) throw new Error("RecordedInjuryFullGMRequired");
    if (write && !(await env.canWrite()))
      throw new Error("RecordedInjuryAuthoritativeGMRequired");
  };
  const otherUsers = () =>
    values(env.game().users)
      .filter((u) => u.active && u.id !== env.game().user.id)
      .map((u) => ({ name: u.name, isGM: Boolean(u.isGM) }));
  const calendarData = (doc) =>
    source(doc)?.flags?.["foundryvtt-simple-calendar-reborn"]?.noteData;
  const notes = () => values(env.game().journal).filter((j) => calendarData(j));
  const page = (j) => values(j.pages).find((p) => p.type === "text");
  const pageText = (j) => String(source(page(j))?.text?.content ?? "");
  const assigned = (a) => env.isAssigned(a);
  async function snapshot(input) {
    const actor = await env.fromUuid(input.actorUuid);
    const evidence = await env.fromUuid(input.sourceUuid);
    if (!actor || !assigned(actor) || !evidence)
      throw new Error("RecordedInjurySourceUnavailable");
    if (
      evidence.documentName === "ActiveEffect" &&
      evidence.parent?.uuid !== actor.uuid
    )
      throw new Error("RecordedInjurySourceActorMismatch");
    if (evidence.documentName !== "ActiveEffect" && !calendarData(evidence))
      throw new Error("RecordedInjurySourceNotInjuryEvidence");
    const api = env.calendar();
    if (!api?.getCurrentCalendar || !api?.addNote)
      throw new Error("RecordedInjuryCalendarUnavailable");
    const calendar = await api.getCurrentCalendar();
    const id = (await hash([input.actorUuid, input.sourceUuid])).slice(0, 24);
    const startMarker = `<!-- infinity-recorded-injury:${id}:start -->`;
    const endMarker = `<!-- infinity-recorded-injury:${id}:end -->`;
    const matches = notes().filter((j) => pageText(j).includes(startMarker));
    const previous =
      actor.flags?.[MODULE_ID]?.[RECORDED_INJURY_FLAG]?.[id] ?? null;
    if (
      previous?.calendarUuid &&
      !matches.some((j) => j.uuid === previous.calendarUuid)
    )
      throw new Error("RecordedInjuryLinkedCalendarMarkerChanged");
    if (matches.length > 1)
      throw new Error("RecordedInjuryDuplicateCalendarMarker");
    const explicit = input.calendarUuid
      ? await env.fromUuid(input.calendarUuid)
      : null;
    if (input.calendarUuid && !explicit)
      throw new Error("RecordedInjuryCalendarMissing");
    if (explicit && matches.length && matches[0].uuid !== explicit.uuid)
      throw new Error("RecordedInjuryCalendarLinkConflict");
    const note = explicit ?? matches[0] ?? null;
    const nd = note ? calendarData(note) : null;
    if (
      note &&
      (!nd ||
        nd.calendarId !== calendar.id ||
        nd.repeats !== 0 ||
        (nd.macro && nd.macro !== "none") ||
        !page(note))
    )
      throw new Error("RecordedInjuryCalendarIdentityInvalid");
    const date = nd?.startDate ?? input.date;
    const months = calendar.months;
    if (
      !date ||
      !months?.[date.month] ||
      date.day >= months[date.month].numberOfDays
    )
      throw new Error("RecordedInjuryCalendarDateInvalid");
    const calendarLabel = `${input.dateMeaning === "historical" ? "Historical calendar entry" : input.dateMeaning === "recorded" ? "Recorded" : input.dateMeaning === "recovery" ? "Recovery" : "Injury"}: ${months[date.month].name} ${date.day + 1}, ${date.year}`;
    const beforeText = note ? pageText(note) : "";
    const block = `${startMarker}<section><h2>Injury record: ${escape(actor.name)}</h2><p><strong>${escape(input.label)}</strong> — ${escape(input.status)}</p><p>${escape(input.notes)}</p><p>${escape(calendarLabel)}. ${input.dateMeaning === "recorded" ? "This is the recording date; the original injury date is unknown." : "Existing campaign date preserved."}</p><p>Source: @UUID[${input.sourceUuid}]</p></section>${endMarker}`;
    const start = beforeText.indexOf(startMarker);
    const end = beforeText.indexOf(endMarker);
    if (start >= 0 !== end >= 0 || (start >= 0 && end < start))
      throw new Error("RecordedInjuryCalendarMarkerMalformed");
    const content =
      start >= 0
        ? beforeText.slice(0, start) +
          block +
          beforeText.slice(end + endMarker.length)
        : beforeText + block;
    if (
      !previous &&
      Object.keys(actor.flags?.[MODULE_ID]?.[RECORDED_INJURY_FLAG] ?? {})
        .length >= 100
    )
      throw new Error("RecordedInjuryRecordLimit");
    const record = {
      schema: 1,
      id,
      actorUuid: actor.uuid,
      sourceUuid: input.sourceUuid,
      label: input.label,
      status: input.status,
      notes: input.notes,
      calendarUuid: note?.uuid ?? null,
      calendarLabel,
      dateMeaning: input.dateMeaning,
      date: clone(date),
      automation: "manual-record",
    };
    const stateHash = await hash({
      actor: source(actor),
      evidence: source(evidence),
      note: note ? source(note) : null,
      calendar: source(calendar),
      noteIds: notes()
        .map((j) => j.uuid)
        .sort(),
      moduleVersion: env.game().modules.get(MODULE_ID)?.version,
      assignedUsers: values(env.game().users).map((u) => [
        u.id,
        u.role,
        typeof u.character === "string" ? u.character : u.character?.id,
      ]),
    });
    return {
      actor,
      note,
      api,
      calendar,
      id,
      startMarker,
      stateHash,
      content,
      record,
      previous,
      sourceEvidence: {
        uuid: evidence.uuid,
        name: evidence.name,
        description: String(evidence.description ?? "").slice(0, 5000),
        disabled: Boolean(evidence.disabled),
      },
      title: `${actor.name} — ${input.label} (${input.status})`,
    };
  }
  return {
    version: 1,
    async read() {
      await guard();
      const loadedMessages = values(env.game().messages);
      const scannedMessages = loadedMessages.slice(-1000);
      const matchedMessages = scannedMessages.filter((m) =>
        /injur|nerve damage|scarring|dislocat|missing (leg|arm)|lost limb/i.test(
          m.content ?? "",
        ),
      );
      return {
        ok: true,
        apiVersion: 1,
        writable: Boolean(await env.canWrite()),
        actors: values(env.game().actors)
          .filter(assigned)
          .map((a) => ({
            uuid: a.uuid,
            name: a.name,
            records: getRecordedInjuryRows(a),
            effects: values(a.effects).map((e) => ({
              uuid: e.uuid,
              name: e.name,
              disabled: e.disabled,
              description: String(e.description ?? "").slice(0, 5000),
              tracked: Boolean(e.flags?.[MODULE_ID]?.criticalInjury?.id),
            })),
          })),
        chatScan: {
          loaded: loadedMessages.length,
          scanned: scannedMessages.length,
          matched: matchedMessages.length,
          returned: Math.min(30, matchedMessages.length),
          truncated:
            loadedMessages.length > 1000 || matchedMessages.length > 30,
        },
        recentInjuryMessages: matchedMessages.slice(-30).map((m) => ({
          uuid: m.uuid,
          timestamp: m.timestamp,
          speaker: m.speaker?.alias,
          content: String(m.content).slice(0, 3000),
          contentTruncated: String(m.content).length > 3000,
        })),
        otherActiveUsers: otherUsers(),
      };
    },
    async preview(raw) {
      await guard(true);
      const input = normalizeRecordedInjury(raw);
      const snap = await snapshot(input);
      const previewId = globalThis.crypto.randomUUID();
      const expiresAtMs = now() + 600_000;
      for (const [id, p] of previews)
        if (p.expiresAtMs <= now()) previews.delete(id);
      const p = {
        input,
        userId: env.game().user.id,
        stateHash: snap.stateHash,
        expiresAtMs,
      };
      previews.set(previewId, p);
      return {
        ok: true,
        previewId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        reason: input.reason,
        target: {
          actorUuid: input.actorUuid,
          actorName: snap.actor.name,
          sourceUuid: input.sourceUuid,
        },
        sourceEvidence: snap.sourceEvidence,
        before: {
          record: snap.previous,
          calendarUuid: snap.note?.uuid ?? null,
          calendarContent: snap.note ? pageText(snap.note) : null,
        },
        proposed: {
          record: snap.record,
          calendarTitle: snap.note?.name ?? snap.title,
          calendarContent: snap.content,
        },
        snapshotHash: snap.stateHash,
        otherActiveUsers: otherUsers(),
        changesEffects: false,
        rollsDice: false,
        advancesTime: false,
      };
    },
    async apply({ previewId } = {}) {
      await guard(true);
      if (inFlight) throw new Error("RecordedInjuryWriteBusy");
      const done = completed.get(previewId);
      if (
        done &&
        done.userId === env.game().user.id &&
        done.expiresAtMs > now()
      )
        return { ...clone(done.result), replayed: true };
      const p = previews.get(previewId);
      if (!p || p.expiresAtMs <= now() || p.userId !== env.game().user.id)
        throw new Error("RecordedInjuryPreviewExpiredOrUserChanged");
      inFlight = true;
      let wrote = false;
      try {
        const s = await snapshot(p.input);
        if (s.stateHash !== p.stateHash)
          throw new Error("RecordedInjuryStateChanged");
        await guard(true);
        if (env.game().user.id !== p.userId)
          throw new Error("RecordedInjuryGMChanged");
        const actorBefore = await hash(source(s.actor));
        let note = s.note;
        if (!note) {
          wrote = true;
          const date = { ...s.record.date, hour: 0, minute: 0, seconds: 0 };
          await s.api.addNote(
            s.title,
            s.content,
            date,
            date,
            true,
            0,
            [],
            s.calendar.id,
            null,
            ["default"],
          );
          const matches = notes().filter((j) =>
            pageText(j).includes(s.startMarker),
          );
          if (matches.length !== 1)
            throw new Error("RecordedInjuryCalendarCreateReadbackFailed");
          note = matches[0];
        } else if (pageText(note) !== s.content) {
          wrote = true;
          await page(note).update({ "text.content": s.content });
        }
        if (
          pageText(note) !== s.content ||
          calendarData(note)?.calendarId !== s.calendar.id
        )
          throw new Error("RecordedInjuryCalendarReadbackFailed");
        await guard(true);
        if (
          env.game().user.id !== p.userId ||
          (await hash(source(s.actor))) !== actorBefore
        )
          throw new Error("RecordedInjuryActorChangedDuringCalendarWrite");
        const record = { ...s.record, calendarUuid: note.uuid };
        wrote = true;
        await s.actor.update({
          [`flags.${MODULE_ID}.${RECORDED_INJURY_FLAG}.${s.id}`]: record,
        });
        if (
          JSON.stringify(
            s.actor.flags?.[MODULE_ID]?.[RECORDED_INJURY_FLAG]?.[s.id],
          ) !== JSON.stringify(record)
        )
          throw new Error("RecordedInjuryReadbackFailed");
        const nd = calendarData(note);
        const result = {
          ok: true,
          previewId,
          replayed: false,
          record,
          triage: getRecordedInjuryRows(s.actor).find((r) => r.id === s.id),
          calendar: {
            uuid: note.uuid,
            name: note.name,
            content: pageText(note),
            dates: {
              calendarId: nd.calendarId,
              startDate: clone(nd.startDate),
              endDate: clone(nd.endDate),
              repeats: nd.repeats,
            },
          },
          otherActiveUsers: otherUsers(),
          changesEffects: false,
          rollsDice: false,
          advancesTime: false,
        };
        completed.set(previewId, {
          result,
          userId: p.userId,
          expiresAtMs: p.expiresAtMs,
        });
        previews.delete(previewId);
        return result;
      } catch (error) {
        error.partialWritePossible = wrote;
        throw error;
      } finally {
        inFlight = false;
      }
    },
  };
}
