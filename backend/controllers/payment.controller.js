import Coupon from "../models/coupon.model.js";
import { stripe } from "../lib/stripe.js";
import Order from "../models/order.model.js";

export const createCheckoutSession = async (req, res) => {
  try {
    const { products, couponCode } = req.body;

    //checking whether cart is having an empty array or checking whether it is an array or not
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "Invalid or empty products array" });
    }

    // !! IMPORTANT: Placeholder exchange rate. Replace with a dynamic API call in production!
    const INR_TO_USD_RATE = 0.012; // Example: 1 INR = 0.012 USD

    //calculating total amount (this local totalAmount is for your own logic, Stripe calculates based on line items)
    let localTotalAmountInINR = 0;

    const lineItems = products.map((product) => {
      // product.price is assumed to be in INR
      const priceInINR = product.price;
      localTotalAmountInINR += priceInINR * product.quantity;

      // Convert INR price to USD
      const priceInUSD = priceInINR * INR_TO_USD_RATE;

      // Convert USD price to cents for Stripe
      const amountInUSDCents = Math.round(priceInUSD * 100);

      return {
        price_data: {
          currency: "usd", // Currency is now correctly USD
          product_data: {
            name: product.name,
            images: [product.image], // this needs to be in form of an array that is why wrapped in []
          },
          unit_amount: amountInUSDCents, // Amount in USD cents
        },
        quantity: product.quantity || 1,
      };
    });

    let coupon = null; //first it is null and later we will check
    let discountedTotalAmountInINR = localTotalAmountInINR; // Start with the non-discounted INR total

    if (couponCode) {
      coupon = await Coupon.findOne({
        code: couponCode,
        userId: req.user._id,
        isActive: true,
      });

      if (coupon) {
        // Apply discount to the INR total for your local logic (e.g., for creating new coupon)
        const discountValueINR = Math.round(
          (localTotalAmountInINR * coupon.discountPercentage) / 100
        );
        discountedTotalAmountInINR -= discountValueINR;
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems, // it is the format that stripe wants us to input
      mode: "payment",
      success_url: `${process.env.CLIENT_URL}/purchase-success?session_id={CHECKOUT_SESSION_ID}`, //yeh '_' lagana hogaa kyuki stripe ka yeh format hai and u cannot change that
      cancel_url: `${process.env.CLIENT_URL}/purchase-cancel`,
      discounts: coupon //discounts is an array
        ? [
            {
              // Stripe will apply this percentage off to the USD total of line_items
              coupon: await createStripeCoupon(coupon.discountPercentage),
            },
          ]
        : [],
      metadata: {
        //stripe is storing the metadata in its own server and we can extract that whenever ever we want
        userId: req.user._id.toString(), //it is object by default from mongoDB so we need to convert it to string as stripe takes string
        couponCode: couponCode || "",
        products: JSON.stringify(
          products.map((p) => ({
            id: p._id,
            quantity: p.quantity,
            price: p.price, // Store original INR price in metadata for your records
          }))
        ),
      },
    });

    // Your logic for creating a new coupon based on the INR amount
    // Note: discountedTotalAmountInINR is in INR (e.g., 20000 INR)
    // Convert the threshold to INR cents if it was meant to be 200.00 INR
    const newCouponThresholdINRCents = 20000 * 100; // If 20000 was $200, this needs adjustment. Let's assume 20000 INR here.
    if (discountedTotalAmountInINR * 100 >= newCouponThresholdINRCents) {
      // Assuming 20000 was an INR value (e.g. 20000 INR)
      // Or if your original 20000 check was for CENTS (e.g., 200.00), then:
      // if (discountedTotalAmountInINR >= 20000) { // if 20000 was INR
      await createNewCoupon(req.user._id);
    }
    // The totalAmount returned to client should ideally be in USD if you converted
    // Stripe session.amount_total will be in USD cents.
    // For consistency, let's send the Stripe session's total.
    res
      .status(200)
      .json({ id: session.id, totalAmountUSD: session.amount_total / 100 });
  } catch (error) {
    console.error("Full error object during checkout:", error); // Log the full error object
    // It can also be helpful to log specific parts of Stripe's error if available
    if (error.raw) {
      console.error("Stripe raw error:", error.raw);
    }
    // Send a more detailed error response to the client
    res.status(500).json({
      message: "Error processing checkout",
      errorDetails: {
        message: error.message,
        type: error.type, // E.g., 'StripeCardError', 'StripeInvalidRequestError'
        code: error.code, // E.g., 'card_declined', 'parameter_invalid_empty'
        param: error.param, // The parameter that caused the error, if any
        statusCode: error.statusCode, // HTTP status code from Stripe's API
        requestId: error.requestId, // Stripe request ID, useful for support
      },
    });
  }
};

export const checkoutSuccess = async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await stripe.checkout.sessions.retrieve(sessionId); // yaha par agar koi seesion create hua ho toh usse retrieve kr rhe haii

    if (session.payment_status === "paid") {
      if (session.metadata.couponCode) {
        await Coupon.findOneAndUpdate(
          //yaha par coupon ko find krke database me se usko status change krna haii taki woh dubara use na ho ske
          {
            code: session.metadata.couponCode,
            userId: session.metadata.userId,
          },
          {
            isActive: false,
          }
        );
      }

      //create a new Order
      const products = JSON.parse(session.metadata.products); //yaha par ham saara order ke details fetch kr rhe haii taki usko store kr ske aur aage use kr skee
      const newOrder = new Order({
        // yeh new isiliye kyuki database me pehli baar store ho rha hai
        user: session.metadata.userId,
        products: products.map((product) => ({
          // same as what we have in order model in products array
          product: product.id,
          quantity: product.quantity,
          price: product.price,
        })),
        totalAmount: session.amount_total,
        stripeSessionId: sessionId,
      });

      await newOrder.save(); //jo order ka model hai na waha moongoDB database me store ho rha haiii

      res.status(200).json({
        success: true,
        message:
          "Payment successful, order created and coupon deactivated if used.",
        orderId: newOrder._id,
      });
    }
  } catch (error) {
    console.log("Error in checkoutSuccess controller", error.message);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

async function createStripeCoupon(discountPercentage) {
  //create one time use coupon in stripe
  const coupon = await stripe.coupons.create({
    percent_off: discountPercentage,
    duration: "once", // once used it will be expired
  });

  return coupon.id;
}

async function createNewCoupon(userId) {
  await Coupon.findOneAndDelete({ userId });
  //create a new coupon in database
  const newCoupon = new Coupon({
    /*
        Math.random() Output: 0.874523849
        Base-36 Conversion: "0.wxyz12" (from 0.874523849.toString(36))
        Extract Substring: "wxyz12" (from .substring(2, 8))
        Convert to Uppercase: "WXYZ12"
        Concatenate with Prefix: "GIFTWXYZ12"
    */

    code: "GIFT" + Math.random().toString(36).substring(2, 8).toUpperCase(), //for random value for the coupon
    discountPercentage: 10,
    expirationDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), //30days froom now
    userId: userId,
  });

  await newCoupon.save();

  return newCoupon;
}

/*how it is working?

////MongoDB Coupon Validation

When the user provides a couponCode, the backend first validates this code in the MongoDB database.

MongoDB checks:
If the coupon exists.
If it belongs to the user (userId).
If it is active.
Its discount percentage.

If a valid coupon is found, the discount percentage is retrieved.

///// Creating a Stripe Coupon

Using the discount percentage from the MongoDB coupon, the backend creates a corresponding Stripe coupon dynamically.
The Stripe coupon is not stored in MongoDB; it is used only during payment processing.

The resulting stripe_coupon_id is included in the Stripe checkout session.

////Linking During Payment

In the Stripe checkout session, the stripe_coupon_id is applied as a discount.
Along with the stripe_coupon_id, metadata (custom fields) is sent to Stripe, including the MongoDB couponCode and userId.

/////Post-Payment: Deactivating the MongoDB Coupon

After a successful payment, the metadata sent with the checkout session is retrieved.
The backend checks the couponCode and userId in the metadata to find the MongoDB coupon.
The MongoDB coupon is then marked as inactive.

//////How They Stay Connected

***Shared Data:

The discount percentage connects MongoDB and Stripe coupons logically.
Metadata ensures the MongoDB couponCode and userId are carried forward.


***Workflow Connection:

MongoDB manages the business logic for coupons.
Stripe uses the coupon during payment for the transactional discount.
After payment, the metadata links the Stripe session back to the MongoDB coupon for deactivation.

*/
