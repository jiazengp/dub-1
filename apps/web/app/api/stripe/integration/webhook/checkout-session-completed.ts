import { notifyPartnerSale } from "@/lib/api/partners/notify-partner-sale";
import { createSaleData } from "@/lib/api/sales/create-sale-data";
import { createId } from "@/lib/api/utils";
import {
  getClickEvent,
  getLeadEvent,
  recordLead,
  recordSale,
} from "@/lib/tinybird";
import { redis } from "@/lib/upstash";
import { sendWorkspaceWebhook } from "@/lib/webhook/publish";
import {
  transformLeadEventData,
  transformSaleEventData,
} from "@/lib/webhook/transform";
import z from "@/lib/zod";
import { clickEventSchemaTB } from "@/lib/zod/schemas/clicks";
import { leadEventSchemaTB } from "@/lib/zod/schemas/leads";
import { prisma } from "@dub/prisma";
import { Customer } from "@dub/prisma/client";
import { nanoid } from "@dub/utils";
import { waitUntil } from "@vercel/functions";
import type Stripe from "stripe";

// Handle event "checkout.session.completed"
export async function checkoutSessionCompleted(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Checkout.Session;
  const dubCustomerId = charge.metadata?.dubCustomerId;
  const clientReferenceId = charge.client_reference_id;
  const stripeAccountId = event.account as string;
  const stripeCustomerId = charge.customer as string;
  const stripeCustomerName = charge.customer_details?.name;
  const stripeCustomerEmail = charge.customer_details?.email;
  const invoiceId = charge.invoice as string;

  let customer: Customer;
  let clickEvent: z.infer<typeof clickEventSchemaTB> | null = null;
  let leadEvent: z.infer<typeof leadEventSchemaTB>;
  let linkId: string;

  /*
    for regular stripe checkout setup:
    - if dubCustomerId is found, we update the customer with the stripe customerId
    - we then find the lead event using the customer's unique ID on Dub
    - the lead event will then be passed to the remaining logic to record a sale
  */
  if (dubCustomerId) {
    try {
      // Update customer with stripe customerId if exists
      customer = await prisma.customer.update({
        where: {
          projectConnectId_externalId: {
            projectConnectId: stripeAccountId,
            externalId: dubCustomerId,
          },
        },
        data: {
          stripeCustomerId,
        },
      });
    } catch (error) {
      // Skip if customer not found
      console.log(error);
      return `Customer with dubCustomerId ${dubCustomerId} not found, skipping...`;
    }

    if (invoiceId) {
      // Skip if invoice id is already processed
      const ok = await redis.set(`dub_sale_events:invoiceId:${invoiceId}`, 1, {
        ex: 60 * 60 * 24 * 7,
        nx: true,
      });

      if (!ok) {
        console.info(
          "[Stripe Webhook] Skipping already processed invoice.",
          invoiceId,
        );
        return `Invoice with ID ${invoiceId} already processed, skipping...`;
      }
    }

    // Find lead
    leadEvent = await getLeadEvent({ customerId: customer.id }).then(
      (res) => res.data[0],
    );

    linkId = leadEvent.link_id;

    /*
      for stripe checkout links:
      - if client_reference_id is a dub_id, we find the click event
      - the click event will be used to create a lead event + customer
      - the lead event will then be passed to the remaining logic to record a sale
    */
  } else if (clientReferenceId?.startsWith("dub_id_")) {
    const dubClickId = clientReferenceId.split("dub_id_")[1];

    clickEvent = await getClickEvent({ clickId: dubClickId }).then(
      (res) => res.data[0],
    );

    if (!clickEvent) {
      return `Click event with dub_id ${dubClickId} not found, skipping...`;
    }

    const workspace = await prisma.project.findUnique({
      where: {
        stripeConnectId: stripeAccountId,
      },
      select: {
        id: true,
      },
    });

    if (!workspace) {
      return `Workspace with stripeConnectId ${stripeAccountId} not found, skipping...`;
    }

    customer = await prisma.customer.create({
      data: {
        id: createId({ prefix: "cus_" }),
        name: stripeCustomerName,
        email: stripeCustomerEmail,
        externalId: stripeCustomerEmail, // using Stripe customer email as externalId
        projectId: workspace.id,
        projectConnectId: stripeAccountId,
        stripeCustomerId,
        clickId: clickEvent.click_id,
        linkId: clickEvent.link_id,
        country: clickEvent.country,
        clickedAt: new Date(clickEvent.timestamp + "Z"),
      },
    });

    leadEvent = {
      ...clickEvent,
      event_id: nanoid(16),
      event_name: "Checkout session completed",
      customer_id: customer.id,
      metadata: "",
    };

    await recordLead(leadEvent);
    linkId = clickEvent.link_id;
  } else {
    return `Customer ID not found in Stripe checkout session metadata and client_reference_id is not a dub_id, skipping...`;
  }

  if (charge.amount_total === 0) {
    return `Checkout session completed for Stripe customer ${stripeCustomerId} with invoice ID ${invoiceId} but amount is 0, skipping...`;
  }

  const saleData = {
    ...leadEvent,
    event_id: nanoid(16),
    event_name: "Subscription creation",
    payment_processor: "stripe",
    amount: charge.amount_total!,
    currency: charge.currency!,
    invoice_id: invoiceId || "",
    metadata: JSON.stringify({
      charge,
    }),
  };

  const link = await prisma.link.findUnique({
    where: {
      id: linkId,
    },
  });

  const [_sale, _link, workspace] = await Promise.all([
    recordSale(saleData),

    // update link sales count
    link &&
      prisma.link.update({
        where: {
          id: link.id,
        },
        data: {
          ...(clickEvent && {
            leads: {
              increment: 1,
            },
          }),
          sales: {
            increment: 1,
          },
          saleAmount: {
            increment: charge.amount_total!,
          },
        },
      }),

    // update workspace sales usage
    prisma.project.update({
      where: {
        id: customer.projectId,
      },
      data: {
        usage: {
          increment: clickEvent ? 2 : 1,
        },
        salesUsage: {
          increment: charge.amount_total!,
        },
      },
    }),
  ]);

  // for program links
  if (link?.programId) {
    const { program, partnerId, commissionAmount } =
      await prisma.programEnrollment.findUniqueOrThrow({
        where: {
          linkId: link.id,
        },
        select: {
          program: true,
          partnerId: true,
          commissionAmount: true,
        },
      });

    const saleRecord = createSaleData({
      program,
      partner: {
        id: partnerId,
        commissionAmount,
      },
      customer: {
        id: saleData.customer_id,
        linkId: saleData.link_id,
        clickId: saleData.click_id,
      },
      sale: {
        amount: saleData.amount,
        currency: saleData.currency,
        invoiceId: saleData.invoice_id,
        eventId: saleData.event_id,
        paymentProcessor: saleData.payment_processor,
      },
      metadata: {
        ...leadEvent,
        stripeMetadata: charge,
      },
    });

    await prisma.sale.create({
      data: saleRecord,
    });

    waitUntil(
      notifyPartnerSale({
        partner: {
          id: partnerId,
          referralLink: link.shortLink,
        },
        program,
        sale: {
          amount: saleRecord.amount,
          earnings: saleRecord.earnings,
        },
      }),
    );
  }

  waitUntil(
    (async () => {
      if (clickEvent) {
        await sendWorkspaceWebhook({
          trigger: "lead.created",
          workspace,
          data: transformLeadEventData({
            ...clickEvent,
            link,
            eventName: "Checkout session completed",
            customerId: customer.id,
            customerExternalId: customer.externalId,
            customerName: customer.name,
            customerEmail: customer.email,
            customerAvatar: customer.avatar,
            customerCreatedAt: customer.createdAt,
          }),
        });
      }

      // send workspace webhook
      await sendWorkspaceWebhook({
        trigger: "sale.created",
        workspace,
        data: transformSaleEventData({
          ...saleData,
          link,
          customerId: customer.id,
          customerExternalId: customer.externalId,
          customerName: customer.name,
          customerEmail: customer.email,
          customerAvatar: customer.avatar,
          customerCreatedAt: customer.createdAt,
        }),
      });
    })(),
  );

  return `Checkout session completed for customer with external ID ${dubCustomerId} and invoice ID ${invoiceId}`;
}
