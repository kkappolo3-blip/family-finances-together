import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Check, Eraser, Home, LogOut, Send, Trash2, WalletCards, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  buildAssistantReply,
  FinanceEntry,
  formatRupiah,
  isReportQuery,
  parseFinanceText,
  Role,
} from "@/lib/familyFinance";

type Session = Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"];
type FamilyState = { familyId: string; familyName: string; memberId: string; role: Role; inviteCode?: string };
type ChatMessage = { id: string; content: string; kind: "user" | "assistant" | "system"; member_id: string; created_at: string; family_members?: { role: Role } | null };

const STORAGE_KEY = "keluarga-finance-session";

const Index = () => {
  const [session, setSession] = useState<Session>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [role, setRole] = useState<Role>("ayah");
  const [family, setFamily] = useState<FamilyState | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    supabase.auth.getSession().then(({ data: current }) => setSession(current.session));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (family) localStorage.setItem(STORAGE_KEY, JSON.stringify(family));
  }, [family]);

  useEffect(() => {
    if (!session || !family?.familyId) return;
    loadFamilyData();
    const channel = supabase
      .channel(`family-${family.familyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages", filter: `family_id=eq.${family.familyId}` }, loadFamilyData)
      .on("postgres_changes", { event: "*", schema: "public", table: "finance_entries", filter: `family_id=eq.${family.familyId}` }, loadFamilyData)
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [session?.user.id, family?.familyId]);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [messages.length]);

  const totals = useMemo(() => {
    const active = entries.filter((entry) => entry.status !== "deleted");
    const sum = (list: FinanceEntry[]) => list.reduce((s, e) => s + Number(e.amount || 0), 0);
    const income = sum(active.filter((e) => e.type === "income"));
    // Pengeluaran langsung kurangi saldo
    const directExpense = sum(active.filter((e) => ["expense", "shopping"].includes(e.type)));
    // Tagihan & hutang hanya kurangi saldo setelah dilunasi
    const settledLiabilities = sum(active.filter((e) => ["bill", "debt"].includes(e.type) && e.status === "paid"));
    // Hutang yang belum dibayar = uang yang kita terima (saldo bertambah)
    const openDebt = sum(active.filter((e) => e.type === "debt" && e.status === "open"));
    // Piutang yang belum tertagih (orang lain hutang ke kita) tidak ditambah ke saldo cash,
    // tapi tetap dihitung sebagai aset. Kalau mau cash murni, jangan tambahkan.
    const receivable = sum(active.filter((e) => e.type === "receivable" && e.status === "open"));
    const expense = directExpense + settledLiabilities;
    const balance = income + openDebt + receivable - expense;
    return { active, income, expense, balance };
  }, [entries]);

  const loadFamilyData = async () => {
    if (!family?.familyId) return;
    const [{ data: chatData }, { data: entryData }] = await Promise.all([
      supabase.from("chat_messages").select("*, family_members(role)").eq("family_id", family.familyId).order("created_at", { ascending: true }),
      supabase.from("finance_entries").select("*").eq("family_id", family.familyId).order("created_at", { ascending: false }),
    ]);
    setMessages((chatData || []) as ChatMessage[]);
    setEntries((entryData || []) as FinanceEntry[]);
  };

  const handleAuth = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    const action = authMode === "signup" ? supabase.auth.signUp : supabase.auth.signInWithPassword;
    const { error: authError } = await action.call(supabase.auth, { email: email.trim(), password });
    if (authError) return setError(authError.message);
    setNotice(authMode === "signup" ? "Cek email untuk verifikasi, lalu masuk kembali." : "Berhasil masuk.");
  };

  const createFamily = async () => {
    setError("");
    if (familyName.trim().length < 2) return setError("Nama keluarga minimal 2 huruf.");
    const { data, error: createError } = await supabase.rpc("create_family", { _family_name: familyName.trim(), _role: role });
    if (createError) return setError(createError.message);
    const row = data?.[0];
    if (row) setFamily({ familyId: row.family_id, familyName: familyName.trim(), memberId: row.member_id, role, inviteCode: row.invite_code });
  };

  const joinFamily = async () => {
    setError("");
    if (inviteCode.trim().length < 4) return setError("Kode keluarga wajib diisi.");
    const { data, error: joinError } = await supabase.rpc("join_family_by_code", { _invite_code: inviteCode.trim(), _role: role });
    if (joinError) return setError(joinError.message);
    const row = data?.[0];
    if (row) setFamily({ familyId: row.family_id, familyName: row.family_name, memberId: row.member_id, role });
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!family || !input.trim()) return;
    const text = input.trim();
    setInput("");
    const { data: message } = await supabase
      .from("chat_messages")
      .insert({ family_id: family.familyId, member_id: family.memberId, content: text, kind: "user" })
      .select()
      .single();

    // Ask AI to interpret the message
    let aiResult: any = null;
    try {
      const recent = entries
        .filter((e) => e.status !== "deleted")
        .slice(0, 10)
        .map((e) => ({ id: e.id, type: e.type, title: e.title, amount: e.amount, status: e.status }));
      const { data, error: fnError } = await supabase.functions.invoke("parse-finance", { body: { text, recent } });
      if (fnError) throw fnError;
      aiResult = data;
    } catch (err) {
      console.error("AI parse failed, falling back to regex", err);
    }

    // Fallback: simple regex parser if AI unavailable
    if (!aiResult || aiResult.error) {
      if (/^hapus terakhir$/i.test(text)) {
        const last = entries.find((e) => e.status !== "deleted");
        if (last) await supabase.from("finance_entries").update({ status: "deleted" }).eq("id", last.id);
        await addAssistant(last ? `Entri terakhir "${last.title}" dibatalkan.` : "Belum ada entri untuk dibatalkan.");
        return;
      }
      if (isReportQuery(text)) return void addAssistant(buildAssistantReply(text, entries));
      const parsed = parseFinanceText(text);
      if (parsed) {
        await supabase.from("finance_entries").insert({
          family_id: family.familyId,
          member_id: family.memberId,
          source_message_id: message?.id ?? null,
          type: parsed.type,
          title: parsed.title,
          amount: parsed.amount,
          category: parsed.category ?? null,
          metadata: (parsed.metadata ?? {}) as Json,
        });
        await addAssistant(`${labelFor(parsed.type)} dicatat: ${parsed.title}${parsed.amount ? ` • ${formatRupiah(parsed.amount)}` : ""}.`);
      } else {
        await addAssistant("AI sedang sibuk. Coba lagi sebentar, atau ketik contoh: gaji 8jt.");
      }
      return;
    }

    const { action, entry, target_id, target_title, reply } = aiResult;
    const activeEntries = entries.filter((e) => e.status !== "deleted");
    const findTarget = (predicate?: (e: FinanceEntry) => boolean) => {
      if (target_id) {
        const byId = activeEntries.find((e) => e.id === target_id);
        if (byId) return byId;
      }
      if (target_title) {
        const t = target_title.toLowerCase();
        const byTitle = activeEntries.find((e) => e.title.toLowerCase().includes(t) && (!predicate || predicate(e)));
        if (byTitle) return byTitle;
      }
      return predicate ? activeEntries.find(predicate) : activeEntries[0];
    };

    if (action === "delete_last") {
      const target = findTarget();
      if (target) await supabase.from("finance_entries").update({ status: "deleted" }).eq("id", target.id);
      await addAssistant(reply || (target ? `Entri "${target.title}" dibatalkan.` : "Belum ada entri."));
      return;
    }

    if (action === "settle") {
      const found = findTarget((e) => ["bill", "debt"].includes(e.type) && e.status === "open");
      if (found) await supabase.from("finance_entries").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", found.id);
      await addAssistant(reply || (found ? `${found.title} ditandai lunas.` : `Belum menemukan tagihan "${target_title || ""}".`));
      return;
    }

    if (action === "report") {
      await addAssistant(reply || buildAssistantReply(text, entries));
      return;
    }

    if (action === "revise_last" && entry) {
      // Cari target yang tipe-nya cocok dengan entri pengganti
      const target = findTarget((e) => e.type === entry.type);
      if (target) await supabase.from("finance_entries").update({ status: "deleted" }).eq("id", target.id);
      await supabase.from("finance_entries").insert({
        family_id: family.familyId,
        member_id: family.memberId,
        source_message_id: message?.id ?? null,
        type: entry.type,
        title: entry.title,
        amount: entry.amount || 0,
        category: entry.category ?? null,
      });
      await addAssistant(reply || (target ? `Entri "${target.title}" diralat menjadi ${entry.title} • ${formatRupiah(entry.amount || 0)}.` : `Entri baru: ${entry.title} • ${formatRupiah(entry.amount || 0)}.`));
      return;
    }

    if (action === "add_entry" && entry) {
      await supabase.from("finance_entries").insert({
        family_id: family.familyId,
        member_id: family.memberId,
        source_message_id: message?.id ?? null,
        type: entry.type,
        title: entry.title,
        amount: entry.amount || 0,
        category: entry.category ?? null,
      });
      await addAssistant(reply || `${labelFor(entry.type)} dicatat: ${entry.title}${entry.amount ? ` • ${formatRupiah(entry.amount)}` : ""}.`);
      return;
    }

    await addAssistant(reply || "Oke, aku simpan sebagai obrolan.");
  };

  const addAssistant = (content: string) => {
    if (!family) return;
    return supabase.from("chat_messages").insert({ family_id: family.familyId, member_id: family.memberId, content, kind: "assistant" });
  };

  const markPaid = (entry: FinanceEntry) => supabase.from("finance_entries").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", entry.id).then(loadFamilyData);
  const removeEntry = (id: string) => supabase.from("finance_entries").update({ status: "deleted" }).eq("id", id).then(loadFamilyData);
  const deleteMessage = async (id: string) => {
    if (!confirm("Hapus pesan ini?")) return;
    await supabase.from("chat_messages").delete().eq("id", id);
    loadFamilyData();
  };
  const clearHistory = async () => {
    if (!family) return;
    if (!confirm("Bersihkan SEMUA riwayat chat? Tindakan ini tidak bisa dibatalkan.")) return;
    await supabase.from("chat_messages").delete().eq("family_id", family.familyId);
    loadFamilyData();
  };
  const signOut = async () => {
    localStorage.removeItem(STORAGE_KEY);
    setFamily(null);
    await supabase.auth.signOut();
  };

  if (!session) {
    return (
      <main className="home-grain flex min-h-screen items-center justify-center px-5 py-8">
        <section className="w-full max-w-md animate-slide-up rounded-lg border border-border bg-surface p-6 shadow-soft">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-home text-primary-foreground shadow-chat"><Home /></div>
            <div><h1 className="text-2xl font-black">Keuangan Ayah dan Ibu</h1><p className="text-sm text-muted-foreground">Masuk dengan email terverifikasi</p></div>
          </div>
          <form onSubmit={handleAuth} className="space-y-3">
            <Input type="email" required placeholder="email keluarga" value={email} onChange={(event) => setEmail(event.target.value)} />
            <Input type="password" required minLength={6} placeholder="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            {notice && <p className="rounded-md bg-accent/10 px-3 py-2 text-sm text-accent">{notice}</p>}
            <Button className="w-full" variant="father">{authMode === "signin" ? "Masuk" : "Daftar & verifikasi email"}</Button>
          </form>
          <button className="mt-4 w-full text-sm font-bold text-primary" onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}>{authMode === "signin" ? "Belum punya akun? Daftar" : "Sudah verifikasi? Masuk"}</button>
        </section>
      </main>
    );
  }

  if (!family) {
    return (
      <main className="home-grain flex min-h-screen items-center justify-center px-5 py-8">
        <section className="w-full max-w-xl animate-slide-up rounded-lg border border-border bg-surface p-6 shadow-soft">
          <h1 className="text-3xl font-black">Pilih keluarga</h1>
          <p className="mt-1 text-muted-foreground">Buat akun keluarga baru atau gabung dengan kode dari anggota keluarga.</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <Button variant={role === "ayah" ? "father" : "soft"} onClick={() => setRole("ayah")}>Ayah</Button>
            <Button variant={role === "ibu" ? "mother" : "soft"} onClick={() => setRole("ibu")}>Ibu</Button>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-background/60 p-4">
              <h2 className="font-black">Buat keluarga</h2>
              <Input className="mt-3" placeholder="contoh: Ahmad" value={familyName} onChange={(event) => setFamilyName(event.target.value)} />
              <Button className="mt-3 w-full" variant="father" onClick={createFamily}>Buat</Button>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-4">
              <h2 className="font-black">Gabung keluarga</h2>
              <Input className="mt-3 uppercase" placeholder="kode keluarga" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} />
              <Button className="mt-3 w-full" variant="mother" onClick={joinFamily}>Gabung</Button>
            </div>
          </div>
          {error && <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="home-grain min-h-screen bg-paper text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div><h1 className="text-xl font-black sm:text-2xl">Keluarga {family.familyName}</h1><p className="text-xs font-bold text-muted-foreground">Login sebagai {family.role === "ayah" ? "Ayah" : "Ibu"}{family.inviteCode ? ` • kode ${family.inviteCode}` : ""}</p></div>
            <div className="flex gap-2"><Button size="icon" variant="soft" onClick={clearHistory} aria-label="Bersihkan riwayat"><Eraser /></Button><Button size="icon" variant="soft" onClick={() => setReportOpen(true)} aria-label="Buka laporan"><BarChart3 /></Button><Button size="icon" variant="soft" onClick={signOut} aria-label="Keluar"><LogOut /></Button></div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Summary title="Saldo" value={formatRupiah(totals.balance)} icon={<WalletCards />} />
            <Summary title="Masuk" value={formatRupiah(totals.income)} />
            <Summary title="Keluar" value={formatRupiah(totals.expense)} />
          </div>
        </div>
      </header>

      <section className="mx-auto flex max-w-5xl flex-col px-4 py-5">
        <div className="flex-1 space-y-3 overflow-hidden pb-24">
          {messages.length === 0 && <div className="rounded-lg border border-dashed border-border bg-surface/70 p-5 text-center text-muted-foreground">Mulai ngobrol: “makan siang 35rb”, “gaji 8jt”, atau “saldo”.</div>}
          {messages.map((message) => {
            const bubbleRole = message.kind === "assistant" ? "system" : message.family_members?.role || family.role;
            return (
              <div key={message.id} className={cn("group flex items-center gap-2", bubbleRole === "ibu" ? "justify-end" : bubbleRole === "ayah" ? "justify-start" : "justify-center")}>
                {bubbleRole === "ibu" && (
                  <button onClick={() => deleteMessage(message.id)} className="opacity-0 transition group-hover:opacity-60 hover:opacity-100" aria-label="Hapus pesan"><Trash2 className="h-4 w-4" /></button>
                )}
                <div className={cn("max-w-[82%] rounded-lg px-4 py-3 text-sm shadow-chat", bubbleRole === "ayah" && "bg-father text-father-foreground", bubbleRole === "ibu" && "bg-mother text-mother-foreground", bubbleRole === "system" && "bg-surface text-foreground border border-border")}>
                  <p className="mb-1 text-[11px] font-black uppercase opacity-80">{bubbleRole === "ayah" ? "Ayah" : bubbleRole === "ibu" ? "Ibu" : "AI"}</p>
                  {message.content}
                </div>
                {bubbleRole !== "ibu" && (
                  <button onClick={() => deleteMessage(message.id)} className="opacity-0 transition group-hover:opacity-60 hover:opacity-100" aria-label="Hapus pesan"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
        <form onSubmit={sendMessage} className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 p-3 backdrop-blur">
          <div className="mx-auto flex max-w-5xl gap-2"><Input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Tulis: tagihan listrik 250.000, lunasi listrik..." /><Button size="icon" variant={family.role === "ayah" ? "father" : "mother"}><Send /></Button></div>
        </form>
      </section>

      {reportOpen && <Report entries={totals.active} totals={totals} onClose={() => setReportOpen(false)} onPaid={markPaid} onDelete={removeEntry} />}
    </main>
  );
};

const Summary = ({ title, value, icon }: { title: string; value: string; icon?: React.ReactNode }) => <div className="rounded-lg border border-border bg-surface/80 p-3 shadow-soft"><div className="flex items-center gap-2 text-xs font-black text-muted-foreground">{icon}{title}</div><p className="mt-1 truncate text-sm font-black sm:text-base">{value}</p></div>;

const labelFor = (type: string) => ({ income: "Pemasukan", expense: "Pengeluaran", bill: "Tagihan", debt: "Hutang", receivable: "Piutang", note: "Catatan", shopping: "Belanja" }[type] || "Entri");

const Report = ({ entries, totals, onClose, onPaid, onDelete }: { entries: FinanceEntry[]; totals: { income: number; expense: number; balance: number }; onClose: () => void; onPaid: (entry: FinanceEntry) => void; onDelete: (id: string) => void }) => (
  <div className="fixed inset-0 z-30 bg-surface-strong/50 backdrop-blur-sm">
    <aside className="ml-auto flex h-full w-full max-w-xl animate-slide-up flex-col bg-surface p-5 shadow-soft">
      <div className="flex items-center justify-between"><div><h2 className="text-2xl font-black">Laporan lengkap</h2><p className="text-sm text-muted-foreground">Saldo {formatRupiah(totals.balance)} • Masuk {formatRupiah(totals.income)} • Keluar {formatRupiah(totals.expense)}</p></div><Button size="icon" variant="soft" onClick={onClose}><X /></Button></div>
      <div className="mt-5 flex-1 space-y-3 overflow-y-auto pr-1">
        {entries.length === 0 && <p className="rounded-lg border border-dashed border-border p-5 text-center text-muted-foreground">Belum ada transaksi.</p>}
        {entries.map((entry) => <div key={entry.id} className="rounded-lg border border-border bg-background/60 p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black uppercase text-muted-foreground">{labelFor(entry.type)} • {entry.status === "paid" ? "lunas" : "aktif"}</p><h3 className="font-black">{entry.title}</h3><p className="text-sm text-muted-foreground">{entry.amount ? formatRupiah(Number(entry.amount)) : entry.category || "catatan"}</p></div><div className="flex gap-2">{["bill", "debt"].includes(entry.type) && entry.status === "open" && <Button size="icon" variant="soft" onClick={() => onPaid(entry)}><Check /></Button>}<Button size="icon" variant="soft" onClick={() => onDelete(entry.id)}><Trash2 /></Button></div></div></div>)}
      </div>
    </aside>
  </div>
);

export default Index;
