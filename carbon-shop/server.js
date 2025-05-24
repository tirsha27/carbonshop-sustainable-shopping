const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/carbon-shop', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Models
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: String,
  carbonSaved: { type: Number, default: 0 }
});

const ProductSchema = new mongoose.Schema({
  name: String,
  price: Number,
  image: String,
  carbonFootprint: Number,
  description: String
});

const OrderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  products: [{ 
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: Number
  }],
  totalCarbon: Number,
  date: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);

// Authentication Routes
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = new User({
      email,
      password: hashedPassword,
      name
    });
    
    await user.save();
    
    const token = jwt.sign({ id: user._id }, 'your_jwt_secret', { expiresIn: '1h' });
    
    res.status(201).json({ token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    
    const token = jwt.sign({ id: user._id }, 'your_jwt_secret', { expiresIn: '1h' });
    
    res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied' });
  }
  
  jwt.verify(token, 'your_jwt_secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    
    req.user = user;
    next();
  });
};

// Product Routes
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find();
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Order Routes
app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { products } = req.body;
    const productIds = products.map(p => p.product);
    
    const productDetails = await Product.find({ _id: { $in: productIds } });
    
    let totalCarbon = 0;
    products.forEach(item => {
      const product = productDetails.find(p => p._id.toString() === item.product);
      totalCarbon += product.carbonFootprint * item.quantity;
    });
    
    const order = new Order({
      user: req.user.id,
      products,
      totalCarbon
    });
    
    await order.save();
    
    // Update user's carbon saved
    await User.findByIdAndUpdate(req.user.id, { $inc: { carbonSaved: totalCarbon } });
    
    // Emit real-time update
    io.emit('newOrder', { userId: req.user.id, totalCarbon });
    
    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id })
      .populate('products.product')
      .sort({ date: -1 });
    
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User Routes
app.get('/api/user', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Seed some initial products
const seedProducts = async () => {
  const productsCount = await Product.countDocuments();
  
  if (productsCount === 0) {
    const products = [
      {
        name: 'Eco-friendly T-shirt',
        price: 25.99,
        image: 'https://via.placeholder.com/150',
        carbonFootprint: 2.5,
        description: 'Made from organic cotton'
      },
      {
        name: 'Recycled Jeans',
        price: 49.99,
        image: 'https://via.placeholder.com/150',
        carbonFootprint: 4.2,
        description: 'Made from recycled denim'
      },
      {
        name: 'Bamboo Toothbrush',
        price: 5.99,
        image: 'https://via.placeholder.com/150',
        carbonFootprint: 0.5,
        description: 'Biodegradable bamboo handle'
      },
      {
        name: 'Reusable Water Bottle',
        price: 15.99,
        image: 'https://via.placeholder.com/150',
        carbonFootprint: 1.8,
        description: 'Stainless steel, BPA-free'
      }
    ];
    
    await Product.insertMany(products);
    console.log('Products seeded successfully');
  }
};

// Socket.io connection
io.on('connection', (socket) => {
  console.log('New client connected');
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await seedProducts();
});