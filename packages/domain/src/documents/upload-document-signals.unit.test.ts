import { describe, expect, it, vi } from "vitest";
import { UploadConflict, UploadInterrupted } from "./errors";
import { uploadDocument } from "./upload-document";
import { chunked, command, enc, fakeDeadline, fakeUpload, pdf, rejection } from "./upload-fakes";

function withHook(fx: ReturnType<typeof fakeUpload>) {
  const onRetained = vi.fn();
  return { ...fx, onRetained };
}

describe("onRetained", () => {
  it.each([
    [
      "unconfirmed delete after a refused write",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.put = "refuse";
        fx.faults.deleteFails = true;
      },
    ],
    [
      "unknown write outcome",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.put = "failAfterBody";
      },
    ],
    [
      "failed release after a confirmed delete",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.put = "refuse";
        fx.faults.releaseFails = true;
      },
    ],
    [
      "unknown commit outcome",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.finalize = "throw";
      },
    ],
    [
      "id conflict",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.finalize = "conflict";
      },
    ],
  ])("fires exactly once: %s", async (_name, arrange) => {
    const fx = withHook(fakeUpload());
    arrange(fx);
    await expect(uploadDocument(fx, command())).rejects.toBeDefined();
    expect(fx.onRetained).toHaveBeenCalledTimes(1);
    const [event] = fx.onRetained.mock.calls[0] ?? [];
    expect(Object.keys(event).sort()).toEqual(["versionId", "workspaceId"]);
    expect([...fx.reservations.keys()]).toEqual([event.versionId]);
  });

  it("fires once for an existing object under the key", async () => {
    const fx = withHook(fakeUpload());
    fx.objects.set(
      "ws/00000000-0000-4000-8000-000000000002/doc/00000000-0000-4000-8000-000000000064/v/00000000-0000-4000-8000-000000000065",
      enc("x"),
    );
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({ code: "storage.conflict" });
    expect(fx.onRetained).toHaveBeenCalledTimes(1);
  });

  it("fires once for a duplicate whose own object could not be deleted", async () => {
    const fx = withHook(fakeUpload());
    await uploadDocument(fx, command());
    fx.faults.deleteFails = true;
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({ reservation: "retained" });
    expect(fx.onRetained).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["success", () => undefined],
    [
      "a rejection with the reservation released",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.put = "refuse";
      },
    ],
    [
      "a commit recognised after an error",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.finalize = "throwAfterCommit";
      },
    ],
    [
      "a rollback reported by the repository",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.finalize = "rolledBack";
      },
    ],
    [
      "a landed write whose response was lost",
      (fx: ReturnType<typeof fakeUpload>) => {
        fx.faults.put = "commitThenFail";
      },
    ],
  ])("stays silent on %s", async (_name, arrange) => {
    const fx = withHook(fakeUpload());
    arrange(fx);
    await uploadDocument(fx, command()).catch(() => undefined);
    expect(fx.onRetained).not.toHaveBeenCalled();
  });

  it("a throwing hook changes neither the error nor the stored state", async () => {
    const plain = fakeUpload();
    plain.faults.put = "failAfterBody";
    const expected = await uploadDocument(plain, command()).catch((error: unknown) => error);
    const fx = fakeUpload();
    fx.faults.put = "failAfterBody";
    const onRetained = vi.fn(() => {
      throw new Error("log sink down");
    });
    const actual = await uploadDocument({ ...fx, onRetained }, command()).catch(
      (error: unknown) => error,
    );
    expect(onRetained).toHaveBeenCalledTimes(1);
    expect(actual).toMatchObject({ code: "storage.unavailable", reservation: "retained" });
    expect(String(actual)).toBe(String(expected));
    expect(fx.reservations.size).toBe(plain.reservations.size);
  });

  it("does not fire for a conflict-free success", async () => {
    const fx = withHook(fakeUpload());
    expect((await uploadDocument(fx, command())).outcome).toBe("created");
    expect(fx.onRetained).not.toHaveBeenCalled();
    expect(new UploadConflict().code).toBe("upload.conflict");
  });
});

async function* failing(error: Error): AsyncGenerator<Uint8Array> {
  yield pdf.slice(0, 4);
  throw error;
}

describe("interruption classes", () => {
  it.each([
    ["client_disconnected", "upload.client_disconnected"],
    ["idle_timeout", "upload.idle_timeout"],
    ["deadline_exceeded", "upload.deadline_exceeded"],
  ] as const)("%s stays distinct, is cleaned up and released", async (reason, code) => {
    const fx = fakeUpload();
    await expect(
      uploadDocument(fx, command({ body: failing(new UploadInterrupted(reason)) })),
    ).rejects.toEqual(rejection(code, "released"));
    expect(fx.reservations.size + fx.objects.size).toBe(0);
  });

  it("a body that ends short is upload.incomplete, not an interruption", async () => {
    const fx = fakeUpload();
    await expect(uploadDocument(fx, command({ body: chunked(pdf.slice(0, 5)) }))).rejects.toEqual(
      rejection("upload.incomplete", "released"),
    );
  });
});

describe("total deadline", () => {
  it("an expired deadline is refused before anything is reserved", async () => {
    const fx = fakeUpload();
    const { signal } = fakeDeadline(true);
    await expect(uploadDocument(fx, command({ signal }))).rejects.toEqual(
      rejection("upload.deadline_exceeded", "none"),
    );
    expect(fx.log).toEqual([]);
  });

  it("after the last byte it aborts the store call, keeps the reservation and never deletes", async () => {
    const fx = withHook(fakeUpload());
    fx.faults.put = "hangAfterBody";
    const stop = fakeDeadline();
    const pending = uploadDocument(fx, command({ signal: stop.signal }));
    await vi.waitFor(() => expect(fx.log).toContain("put"));
    stop.abort();
    await expect(pending).rejects.toEqual(rejection("storage.unavailable", "retained"));
    expect(fx.reservations.size).toBe(1);
    expect(fx.log).toEqual(["tx", "put", "head"]);
    expect(fx.onRetained).toHaveBeenCalledTimes(1);
  });

  it("a store error raised because the deadline hit mid-body is reported as the deadline", async () => {
    const fx = fakeUpload();
    fx.faults.put = "refuse";
    const stop = fakeDeadline();
    const uow = {
      run: async <T>(...args: Parameters<typeof fx.uow.run<T>>) => {
        const result = await fx.uow.run(...args);
        stop.abort();
        return result;
      },
    };
    await expect(uploadDocument({ ...fx, uow }, command({ signal: stop.signal }))).rejects.toEqual(
      rejection("upload.deadline_exceeded", "released"),
    );
    expect(fx.reservations.size).toBe(0);
  });
});

describe("reservation outcomes", () => {
  it("a known rollback: no object, no reservation, no event", async () => {
    const fx = withHook(fakeUpload());
    fx.faults.reserve = "rolledBack";
    await expect(uploadDocument(fx, command())).rejects.toThrow("deadlock detected");
    expect(fx.log).not.toContain("put");
    expect(fx.reservations.size).toBe(0);
    expect(fx.onRetained).not.toHaveBeenCalled();
  });

  it.each([
    ["a commit whose acknowledgement was lost", "lostAck", 1],
    ["a commit with an unknowable outcome", "unknown", 0],
  ] as const)(
    "%s: nothing is stored, the event fires once, the row (if any) stays",
    async (_n, fault, rows) => {
      const fx = withHook(fakeUpload());
      fx.faults.reserve = fault;
      await expect(uploadDocument(fx, command())).rejects.toMatchObject({
        code: "transaction.outcome_unknown",
      });
      expect(fx.log).toEqual(["tx"]); // no put, head, delete or second transaction
      expect(fx.objects.size).toBe(0);
      expect(fx.reservations.size).toBe(rows);
      expect(fx.onRetained).toHaveBeenCalledTimes(1);
      const [event] = fx.onRetained.mock.calls[0] ?? [];
      expect(Object.keys(event).sort()).toEqual(["versionId", "workspaceId"]);
    },
  );

  it("a throwing hook changes nothing about a lost acknowledgement", async () => {
    const fx = fakeUpload();
    fx.faults.reserve = "lostAck";
    const onRetained = vi.fn(() => {
      throw new Error("log sink down");
    });
    await expect(uploadDocument({ ...fx, onRetained }, command())).rejects.toMatchObject({
      code: "transaction.outcome_unknown",
    });
    expect(onRetained).toHaveBeenCalledTimes(1);
    expect(fx.reservations.size).toBe(1);
  });

  it("a commit outcome that is unknown at finalization keeps the object and the reservation", async () => {
    const fx = withHook(fakeUpload());
    fx.faults.finalize = "unknownCommit";
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({
      code: "transaction.outcome_unknown",
    });
    expect(fx.log).not.toContain("delete");
    expect(fx.objects.size).toBe(1);
    expect(fx.reservations.size).toBe(1);
    expect(fx.onRetained).toHaveBeenCalledTimes(1);
  });

  it("a database timeout at finalization never deletes the object", async () => {
    const fx = withHook(fakeUpload());
    fx.faults.finalize = "timeout";
    await expect(uploadDocument(fx, command())).rejects.toMatchObject({ code: "57014" });
    expect(fx.log).not.toContain("delete");
    expect(fx.objects.size).toBe(1);
    expect(fx.onRetained).toHaveBeenCalledTimes(1);
  });

  it("bounds every transaction it opens, compensation included", async () => {
    const fx = fakeUpload();
    fx.faults.put = "refuse";
    await uploadDocument({ ...fx, transactionTimeoutMs: 2_500 }, command()).catch(() => undefined);
    expect(fx.timeouts).toEqual([2_500, 2_500]); // reserve, release
    const plain = fakeUpload();
    await uploadDocument(plain, command());
    expect(plain.timeouts).toEqual([10_000, 10_000]); // reserve, finalize
  });
});
