import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { API_BEARER_AUTH_SCHEME } from '../common/constants/swagger.constants';
import { AssignBatchDto, ListOrdersQueryDto } from './dto/marketplace-order.dto';
import { MarketplaceOrdersService } from './marketplace-orders.service';

type AuthenticatedRequest = Request & {
  user?: { userId?: string; id?: string };
};

@ApiTags('marketplace')
@ApiBearerAuth(API_BEARER_AUTH_SCHEME)
@UseGuards(JwtAuthGuard)
@Controller('marketplace/orders')
export class MarketplaceOrdersController {
  constructor(private readonly ordersService: MarketplaceOrdersService) {}

  @Get()
  @ApiOperation({ summary: 'List escrowed orders where the user is the buyer or seller' })
  @ApiResponse({ status: 200, description: 'Orders for the given role' })
  findMine(@Query() query: ListOrdersQueryDto, @Req() req: AuthenticatedRequest) {
    return this.ordersService.findForUser(this.userId(req), query.role);
  }

  @Post(':id/dispute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Flag an escrowed order for admin resolution' })
  @ApiResponse({ status: 200, description: 'Order flagged as disputed' })
  @ApiResponse({ status: 403, description: 'Caller is not a party to the order' })
  dispute(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.ordersService.openDispute(id, this.userId(req));
  }

  @Patch(':id/batch')
  @ApiOperation({ summary: 'Seller records the drug batch dispatched for a drug order' })
  @ApiResponse({ status: 200, description: 'Batch recorded on the order' })
  @ApiResponse({ status: 400, description: 'Not a drug order, or invalid batch id' })
  @ApiResponse({ status: 403, description: 'Caller is not the seller' })
  assignBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignBatchDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.ordersService.assignBatch(id, this.userId(req), dto.batchId);
  }

  private userId(req: AuthenticatedRequest): string {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Authenticated user required');
    }
    return userId;
  }
}
