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

// Mensaje que se muestra en la página de resultado IA
function generarMensajePersonalizado(productName, idea) {
  let base = `La elección de ${productName} encaja muy bien con el estilo de tu espacio. `;

  if (idea && idea.trim().length > 0) {
    base += `Tu idea de “${idea.trim()}” aporta un toque muy personal a la composición. `;
  }

  base += "Preparamos esta visualización para que puedas tomar una decisión con total seguridad, viendo cómo se transforma tu ambiente antes de comprar.";

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

  return data.data.products.edges.map((e) => ({
    id: e.node.id,               // id GraphQL
    title: e.node.title,
    handle: e.node.handle,
    description: e.node.description,
    available: e.node.availableForSale,
    url: e.node.onlineStoreUrl,
    image: e.node.featuredImage ? e.node.featuredImage.url : null
  }));
}

// Llamar a Replicate SDXL (image-to-image) para generar la propuesta IA
async function llamarReplicateImagen(roomImageUrl, productName, idea) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    console.warn("REPLICATE_API_TOKEN no definido, devolviendo placeholder.");
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }

  // Prompt muy enfocado a interiores + producto
  const prompt =
    `Fotografía realista de interior, iluminación suave y cálida, estilo editorial premium. ` +
    `Usa la foto proporcionada de la habitación como base y añade de forma natural el producto de decoración "${productName}" en una pared visible. ` +
    (idea && idea.trim().length > 0
      ? `Ten en cuenta que el cliente pidió específicamente: ${idea.trim()}. `
      : `Composición minimalista, equilibrada y acogedora, con el cuadro bien centrado y en proporción correcta. `) +
    `Mantén la arquitectura, la perspectiva y los muebles originales de la habitación. Alta resolución, sin texto ni marcas de agua.`;

  const negativePrompt =
    "low quality, blurry, distorted, deformed, extra limbs, bad anatomy, lowres, artifacts, ugly, oversaturated, cartoon, childish, unrealistic lighting";

  try {
    // Usamos el endpoint oficial de modelo para no tener que poner version hash
    // Docs: POST https://api.replicate.com/v1/models/stability-ai/sdxl/predictions
    const resp = await fetch(
      "https://api.replicate.com/v1/models/stability-ai/sdxl/predictions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Prefer": "wait=60" // esperar hasta 60s para respuesta síncrona
        },
        body: JSON.stringify({
          input: {
            prompt,
            negative_prompt: negativePrompt,
            image: roomImageUrl,         // image-to-image usando la foto real del cliente
            prompt_strength: 0.55,       // balance: respeta bastante la habitación
            num_inference_steps: 28,
            guidance_scale: 7,
            output_format: "png"
          }
        })
      }
    );

    if (!resp.ok) {
      const t = await resp.text();
      console.error("Error Replicate SDXL:", resp.status, t);
      return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
    }

    const prediction = await resp.json();

    // Para modelos de imagen, Replicate suele devolver un array de URLs en prediction.output
    if (
      prediction &&
      prediction.output &&
      Array.isArray(prediction.output) &&
      prediction.output.length > 0
    ) {
      return prediction.output[0];
    }

    console.warn("Respuesta Replicate sin output válido:", prediction);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  } catch (err) {
    console.error("Excepción llamando a Replicate SDXL:", err);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }
}

// =============== RUTAS ===================

app.get("/", (req, res) => {
  res.send("Innotiva Backend con Replicate SDXL funcionando ✅");
});

// Productos para el formulario en Shopify
app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await llamarShopifyProducts();
    return res.json({ success: true, products });
  } catch (err) {
    console.error("ERR /productos-shopify:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Experiencia Premium:
 * - Recibe: roomImage (file), productId, productName, idea, productUrl (opcional)
 * - Sube la imagen del cliente a Cloudinary
 * - Genera propuesta IA con Replicate SDXL (image-to-image)
 * - Devuelve JSON que el front guarda en sessionStorage y muestra en /pages/resultado-ia
 */
app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    try {
      const { productId, productName, idea, productUrl } = req.body;
      const file = req.file;

      if (!file) {
        return res
          .status(400)
          .json({ success: false, error: "roomImage es obligatorio" });
      }

      if (!productId || !productName) {
        return res.status(400).json({
          success: false,
          error: "productId y productName son obligatorios"
        });
      }

      // 1) Subir imagen del cliente a Cloudinary
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

      // 2) Generar propuesta IA con SDXL (image-to-image) usando la foto del cliente
      const generatedImageUrl = await llamarReplicateImagen(
        userImageUrl,
        productName,
        idea
      );

      // 3) Resolver URL final del producto:
      //    - Si viene productUrl desde el front, usamos esa
      //    - Si no, construimos una URL de fallback usando el dominio y el id/handle
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
