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

// =============== CONFIG CLOUDINARY ===================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// =============== HELPERS ===================

// Mensaje personalizado para el usuario
function generarMensajePersonalizado(productName, idea) {
  let base = `La elección de ${productName} encaja muy bien con el estilo de tu espacio. `;

  if (idea && idea.trim().length > 0) {
    base += `Tu idea de “${idea.trim()}” aporta un toque muy personal a la composición. `;
  }

  base +=
    "Preparamos esta visualización para que puedas tomar una decisión con total seguridad, viendo cómo se transforma tu ambiente antes de comprar.";

  return base;
}

// Traer productos desde Shopify Storefront API
async function llamarShopifyProducts() {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;

  if (!shopDomain || !token) {
    throw new Error("Faltan SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN en .env");
  }

  const query = `
    {
      products(first: 50) {
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

  const resp = await fetch(
    `https://${shopDomain}/api/2024-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token
      },
      body: JSON.stringify({ query })
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("Error Shopify: " + resp.status + " " + text);
  }

  const data = await resp.json();

  return data.data.products.edges.map((e) => ({
    id: e.node.id,
    title: e.node.title,
    handle: e.node.handle,
    description: e.node.description,
    available: e.node.availableForSale,
    url: e.node.onlineStoreUrl,
    image: e.node.featuredImage ? e.node.featuredImage.url : null
  }));
}

// =============== REPLICATE SDXL ===============

async function llamarReplicateImagen(roomImageUrl, productName, idea) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    console.warn("REPLICATE_API_TOKEN no definido.");
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }

  const prompt =
    `Realistic interior photograph. Keep the original room, walls, perspective, furniture, and lighting. ` +
    `Integrate the decoration product "${productName}" naturally on a visible wall in the correct scale. ` +
    (idea && idea.trim().length > 0
      ? `Client request: ${idea.trim()}. `
      : `Minimalist, balanced, warm and premium composition. `) +
    `High resolution, elegant shadows, photorealistic. No text, no watermark.`;

  const negative =
    "low quality, blurry, distorted, deformed, ugly, artifacts, oversaturated, cartoon, unrealistic lighting";

  try {
    const resp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Prefer": "wait=60"
      },
      body: JSON.stringify({
        version:
          "8789987683457683f61606b3b2a9bc68d0f3f3b0bb5f74d6a7d8b4a03a0bdc54",
        input: {
          prompt,
          negative_prompt: negative,
          image: roomImageUrl,
          prompt_strength: 0.6,
          guidance_scale: 7,
          num_inference_steps: 30
        }
      })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("Error Replicate SDXL:", resp.status, txt);
      return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
    }

    const prediction = await resp.json();

    if (
      prediction &&
      prediction.output &&
      Array.isArray(prediction.output) &&
      prediction.output.length > 0
    ) {
      return prediction.output[0];
    }

    console.warn("Respuesta Replicate sin output:", prediction);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  } catch (err) {
    console.error("Excepción Replicate SDXL:", err);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }
}

// =============== RUTAS ===================

// Test
app.get("/", (req, res) => {
  res.send("Innotiva Backend con Replicate SDXL funcionando ✅");
});

// Productos Shopify
app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await llamarShopifyProducts();
    return res.json({ success: true, products });
  } catch (err) {
    console.error("ERR /productos-shopify:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Experiencia premium
app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    try {
      const { productId, productName, idea, productUrl } = req.body;
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          success: false,
          error: "roomImage es obligatorio"
        });
      }

      if (!productId || !productName) {
        return res.status(400).json({
          success: false,
          error: "productId y productName son obligatorios"
        });
      }

      // Subir imagen del cliente
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

      // Generar propuesta IA
      const generatedImageUrl = await llamarReplicateImagen(
        userImageUrl,
        productName,
        idea
      );

      const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
      let finalProductUrl = productUrl || null;

      if (!finalProductUrl && shopDomain) {
        finalProductUrl = `https://${shopDomain}/products/${productId}`;
      }

      const message = generarMensajePersonalizado(productName, idea);

      return res.json({
        success: true,
        message,
        userImageUrl,
        generatedImageUrl,
        productUrl: finalProductUrl,
        productName
      });
    } catch (err) {
      console.error("ERR /experiencia-premium:", err);
      return res.status(500).json({
        success: false,
        error: "Error interno preparando la experiencia premium"
      });
    }
  }
);

app.listen(port, () => {
  console.log("Servidor Innotiva con Replicate SDXL escuchando en puerto", port);
});
