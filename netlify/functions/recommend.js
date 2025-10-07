import OpenAI from "openai";

export default async (req, res) => {
  try {
    const body = await req.json();
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
      model: "gpt-5",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: body.prompt },
        { role: "user", content: JSON.stringify(body) }
      ]
    });
    return new Response(response.choices[0].message.content, {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};