const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer en memoria para recibir la imagen
const upload = multer({ storage: multer.memoryStorage() });

// Config Cloudinary (desde .env)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Helpers
function generarMensajePersonalizado(productName, idea) {
  let base = `La elección de ${productName} encaja muy bien con el estilo de tu espacio. `;

  if (idea && idea.trim().length > 0) {
    base += `Tu idea de “${idea.trim()}” aporta un toque muy personal a la composición. `;
  }

  base += "Preparamos esta visualización para que puedas tomar una decisión con total seguridad, viendo cómo se transforma tu ambiente antes de comprar.";

  return base;
}

async function llamarShopifyProducts() {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;

  if (!shopDomain || !token) {
    throw new Error("Faltan SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN en .env");
  }

  const query = `
    {
      products(first: 20) {
        edges {
          node {
            id
            title
            handle
            description
            availableForSale
            onlineStoreUrl
            featuredImage {
              url
            }
          }
        }
      }
    }
  `;

  const resp = await fetch(`https://${shopDomain}/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": token
    },
    body: JSON.stringify({ query })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("Error Shopify: " + resp.status + " " + text);
  }

  const data = await resp.json();
  return data.data.products.edges.map(e => ({
    id: e.node.id,
    title: e.node.title,
    handle: e.node.handle,
    description: e.node.description,
    available: e.node.availableForSale,
    url: e.node.onlineStoreUrl,
    image: e.node.featuredImage ? e.node.featuredImage.url : null
  }));
}

async function llamarOpenAIImagen(productName, idea) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OPENAI_API_KEY no definido, devolviendo placeholder.");
    return "https://via.placeholder.com/500x300?text=Propuesta+IA";
  }

  const prompt = `Visualiza el producto de decoración "${productName}" integrado de forma elegante en un espacio interior real. ${
    idea && idea.trim().length > 0
      ? "El cliente pidió específicamente: " + idea.trim() + "."
      : "El estilo debe sentirse minimalista, cálido y acogedor."
  } Render realista, iluminación suave, estilo fotografía editorial.`;

  try {
    const resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024"
      })
    });

    if (!resp.ok) {
      const t = await resp.text();
      console.error("Error OpenAI:", resp.status, t);
      return "https://via.placeholder.com/500x300?text=Propuesta+IA";
    }

    const data = await resp.json();
    if (data && data.data && data.data[0] && data.data[0].url) {
      return data.data[0].url;
    }

    return "https://via.placeholder.com/500x300?text=Propuesta+IA";
  } catch (err) {
    console.error("Excepción OpenAI:", err);
    return "https://via.placeholder.com/500x300?text=Propuesta+IA";
  }
}

// Rutas

app.get("/", (req, res) => {
  res.send("Innotiva Backend FULL OK");
});

// Productos Shopify para el formulario
app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await llamarShopifyProducts();
    return res.json({ success: true, products });
  } catch (err) {
    console.error("ERR /productos-shopify:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Experiencia premium: recibe foto + producto + idea, sube a Cloudinary, llama OpenAI, responde al front
app.post("/experiencia-premium", upload.single("roomImage"), async (req, res) => {
  try {
    const { productId, productName, idea } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, error: "roomImage es obligatorio" });
    }

    if (!productId || !productName) {
      return res.status(400).json({ success: false, error: "productId y productName son obligatorios" });
    }

    // Subir imagen del cliente a Cloudinary
    const buffer = file.buffer;

    const userImageUrl = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "innotiva/rooms",
          resource_type: "image"
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });

    // Llamar a OpenAI para generar propuesta IA
    const generatedImageUrl = await llamarOpenAIImagen(productName, idea);

    // Construir URL del producto en Shopify (usamos handle si lo pasas como productId)
    const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
    let productUrl = null;
    if (shopDomain) {
      productUrl = `https://${shopDomain}/products/${productId}`;
    }

    const message = generarMensajePersonalizado(productName, idea);

    return res.json({
      success: true,
      message,
      userImageUrl,
      generatedImageUrl,
      productUrl,
      productName
    });
  } catch (err) {
    console.error("ERR /experiencia-premium:", err);
    return res.status(500).json({
      success: false,
      error: "Error interno preparando la experiencia premium"
    });
  }
});

app.listen(port, () => {
  console.log("Servidor Innotiva FULL escuchando en puerto", port);
});
