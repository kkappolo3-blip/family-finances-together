// Edge function: parse free-form Indonesian family finance chat using Lovable AI
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Kamu asisten keuangan keluarga Indonesia. Tugasmu mengubah pesan bebas dari Ayah/Ibu menjadi data terstruktur.

Aturan:
- Pahami bahasa Indonesia santai, singkatan, salah ketik, dan format angka Indonesia (titik = ribuan, koma = desimal). Contoh: "1.050.000" = 1050000, "1,5jt" = 1500000, "8jt" = 8000000, "35rb" = 35000, "100000" = 100000.
- Tentukan action:
  • "add_entry": pesan mencatat transaksi/catatan baru.
  • "revise_last": user ingin meralat/mengoreksi entri terakhirnya (mis. "ralat", "koreksi", "bukan ... tapi", "salah, sebenarnya ..."). Sertakan entri pengganti di field entry.
  • "settle": user ingin menandai tagihan/hutang sebagai lunas (mis. "lunasi listrik", "udah bayar listrik"). Sertakan target_title.
  • "delete_last": user minta hapus entri terakhir ("hapus terakhir", "batalkan tadi").
  • "report": pertanyaan ringkasan/saldo/laporan/hutang/tagihan/catatan.
  • "chat": obrolan lain yang tidak masuk kategori di atas.
- Untuk add_entry & revise_last, isi entry dengan:
  • type: income | expense | bill | debt | receivable | note | shopping
  • title: ringkas (2-6 kata, huruf kecil, tanpa nominal)
  • amount: number rupiah (0 jika tidak ada nominal)
  • category: kata kunci singkat
- Klasifikasi type:
  • income: gaji, bonus, pemasukan, dapat uang
  • expense: belanja/bayar/beli umum tanpa kata khusus
  • bill: tagihan (listrik, air, internet, pulsa, sewa)
  • debt: kita berhutang ke orang/bank
  • receivable: orang berhutang ke kita / piutang
  • shopping: daftar belanja ("catat belanja: ...")
  • note: catatan tanpa nominal
- Jangan menambahkan field di luar skema. Selalu balas via tool call.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { text, recent } = await req.json();
    if (!text || typeof text !== "string") {
      return Response.json({ error: "text required" }, { status: 400, headers: corsHeaders });
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return Response.json({ error: "LOVABLE_API_KEY missing" }, { status: 500, headers: corsHeaders });
    }

    const recentContext = Array.isArray(recent) && recent.length
      ? `\n\nKonteks entri AKTIF terbaru (id penting untuk revise_last/settle/delete_last):\n${recent
          .slice(0, 10)
          .map((e: any, i: number) => `${i + 1}. id=${e.id} [${e.type}] "${e.title}" — ${e.amount} (${e.status})`)
          .join("\n")}\n\nUntuk action revise_last/settle/delete_last, WAJIB sertakan target_id dari daftar di atas yang paling cocok dengan maksud user. Contoh: "ralat gaji" → pilih id entri income terakhir, BUKAN expense terakhir.`
      : "";

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT + recentContext },
          { role: "user", content: text },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "submit_parsed",
              description: "Kembalikan hasil parsing pesan keuangan keluarga.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  action: {
                    type: "string",
                    enum: ["add_entry", "revise_last", "settle", "delete_last", "report", "chat"],
                  },
                  entry: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      type: {
                        type: "string",
                        enum: ["income", "expense", "bill", "debt", "receivable", "note", "shopping"],
                      },
                      title: { type: "string" },
                      amount: { type: "number" },
                      category: { type: "string" },
                    },
                    required: ["type", "title", "amount", "category"],
                  },
                  target_id: { type: "string", description: "Untuk revise_last/settle/delete_last: id entri target dari konteks." },
                  target_title: { type: "string", description: "Fallback nama target jika id tidak tersedia." },
                  reply: { type: "string", description: "Balasan singkat ramah untuk ditampilkan ke user." },
                },
                required: ["action", "reply"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "submit_parsed" } },
      }),
    });

    if (response.status === 429) {
      return Response.json({ error: "rate_limit" }, { status: 429, headers: corsHeaders });
    }
    if (response.status === 402) {
      return Response.json({ error: "payment_required" }, { status: 402, headers: corsHeaders });
    }
    if (!response.ok) {
      const errText = await response.text();
      console.error("AI gateway error", response.status, errText);
      return Response.json({ error: "ai_error", detail: errText }, { status: 500, headers: corsHeaders });
    }

    const data = await response.json();
    const call = data?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) {
      return Response.json({ error: "no_tool_call", raw: data }, { status: 500, headers: corsHeaders });
    }

    const parsed = JSON.parse(call.function.arguments);
    return Response.json(parsed, { headers: corsHeaders });
  } catch (err) {
    console.error("parse-finance error", err);
    return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders });
  }
});
